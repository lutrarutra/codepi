import * as vscode from "vscode";

/**
 * Shared diagnostics ("Problems lens") logic.
 *
 * Used by the `get_diagnostics` tool AND by CodePi's automatic post-edit
 * verification (src/auto-verify.ts) so both lint through exactly the same
 * code path: resolve paths → open documents invisibly to trigger language
 * servers → poll the ext-host diagnostic mirror → format grouped output.
 */

// ── Severity helpers ─────────────────────────────────────────

/** Diagnostic severity names, ordered least→most severe (0=error … 3=hint). */
export const DIAGNOSTIC_SEVERITIES = [
	"error",
	"warning",
	"info",
	"hint",
] as const;
export type DiagnosticSeverityName = (typeof DIAGNOSTIC_SEVERITIES)[number];

/** vscode.Diagnostic.severity (0–3) → name, mirroring DiagnosticSeverity. */
const SEVERITY_NAMES: Record<number, DiagnosticSeverityName> = {
	0: "error",
	1: "warning",
	2: "info",
	3: "hint",
};

/** Sort rank for a severity name (errors first). */
function severityRank(sev: DiagnosticSeverityName): number {
	switch (sev) {
		case "error":
			return 0;
		case "warning":
			return 1;
		case "info":
			return 2;
		case "hint":
			return 3;
	}
}

// ── Path resolution (shared with the other tools) ────────────

export function resolveUri(filePath: string): vscode.Uri {
	if (filePath.startsWith("/")) {
		return vscode.Uri.file(filePath);
	}
	const ws = vscode.workspace.workspaceFolders?.[0];
	if (ws) {
		return vscode.Uri.joinPath(ws.uri, filePath);
	}
	return vscode.Uri.file(filePath);
}

// ── Collection ───────────────────────────────────────────────

/** How long to wait for a freshly opened file's language server (ms). */
export const DIAGNOSTICS_TIMEOUT_MS = 4000;

/** How long a diagnostic set must stay unchanged to count as settled. */
const DIAGNOSTICS_STABLE_MS = 400;

/**
 * How long an empty result must stay quiet before counting as "clean".
 * Longer than the error window because a server may analyze in stages
 * (Pylance publishes syntax results first, semantic results later), so an
 * early "no problems" needs extra confirmation time.
 */
const DIAGNOSTICS_EMPTY_CONFIRM_MS = 1500;

/** Poll interval while waiting for the language server (ms). */
const DIAGNOSTICS_POLL_MS = 150;

/**
 * How long a per-file settle verdict stays valid for an unchanged file (ms).
 * Re-running get_diagnostics on a file the server has already settled makes
 * the answer instant instead of burning the full timeout again.
 */
const SETTLE_CACHE_TTL_MS = 5000;

interface DiagnosticRow {
	sev: DiagnosticSeverityName;
	line: number;
	col: number;
	message: string;
}

/** One-line problem description: message plus source/code/tags. */
function formatDiagnostic(d: vscode.Diagnostic): string {
	let msg = d.message.replace(/\s+/g, " ").trim();
	if (msg.length > 200) msg = msg.slice(0, 200).trimEnd() + "…";
	const bits: string[] = [];
	if (d.source) bits.push(d.source);
	if (d.code !== undefined && d.code !== null) {
		bits.push(String(typeof d.code === "object" ? d.code.value : d.code));
	}
	// vscode.DiagnosticTag: Unnecessary = 1, Deprecated = 2.
	if (d.tags?.includes(1)) bits.push("unnecessary");
	if (d.tags?.includes(2)) bits.push("deprecated");
	return bits.length > 0 ? `${msg} (${bits.join(", ")})` : msg;
}

/**
 * Serialize a diagnostic set for stability comparison. Includes everything
 * the server could re-publish with different metadata (source, code, tags,
 * full range) so "stable" really means nothing changed.
 */
function snapshotKey(diags: readonly vscode.Diagnostic[]): string {
	return diags
		.map((d) => {
			const code =
				d.code === undefined || d.code === null
					? ""
					: typeof d.code === "object"
						? String(d.code.value)
						: String(d.code);
			return [
				d.severity,
				d.range.start.line,
				d.range.start.character,
				d.range.end.line,
				d.range.end.character,
				d.source ?? "",
				code,
				(d.tags ?? []).join(","),
				d.message,
			].join(":");
		})
		.sort()
		.join("\n");
}

/**
 * Result of waiting for a language server to settle:
 * - "settled": the diagnostic set was stable long enough to be confident in
 *   it (a stable "no problems" counts — a server that analyzed the file and
 *   reported nothing has nothing more to say).
 * - "churn":   the server kept changing its results and never settled.
 * - "silent":  the server never reported anything for this file at all.
 */
type SettleOutcome = "settled" | "churn" | "silent";

interface SettleResult {
	outcome: SettleOutcome;
	/** True when the verdict was reused from the settle cache (no waiting). */
	cached: boolean;
}

// ── Settle cache ────────────────────────────────────────────
//
// The heavy cost of a path-scoped check is the wait itself. Once a file has
// been judged (settled, churning, or silent), the same content hash will
// produce the same verdict — the cache makes re-runs instant. It is keyed on
// the analyzed buffer content and invalidated the moment the server publishes
// anything new, so it can never serve a verdict newer diagnostics contradict.

const settleCache = new Map<
	string,
	{ hash: number; outcome: SettleOutcome; expiresAt: number }
>();

let cacheInvalidator: vscode.Disposable | undefined;

function ensureCacheInvalidator(): void {
	if (cacheInvalidator) return;
	cacheInvalidator = vscode.languages.onDidChangeDiagnostics((event) => {
		for (const uri of event.uris) settleCache.delete(uri.toString());
	});
}

/**
 * Forget cached settle verdicts and unsubscribe the invalidator. Called on
 * extension deactivation and by tests.
 */
export function disposeDiagnosticsCache(): void {
	cacheInvalidator?.dispose();
	cacheInvalidator = undefined;
	settleCache.clear();
}

/** Cheap content identity for the settle cache (djb2). */
function contentHash(text: string): number {
	let hash = 5381;
	for (let i = 0; i < text.length; i++) {
		hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
	}
	return hash;
}

/**
 * Wait until the language server's diagnostics for a document have settled.
 *
 * There is no VS Code API to force a re-analysis or await its completion
 * (diagnostics arrive as async server pushes), so this approximates it:
 * - the diagnostic set unchanged for DIAGNOSTICS_STABLE_MS is "settled" —
 *   including an empty set, either because the server cleared problems it
 *   had reported or (with a longer confirmation window) because it talked
 *   and reported nothing;
 * - total silence for the whole budget is "silent" (callers soften the
 *   claim, never assert a confident "clean");
 * - results that keep changing for the whole budget are "churn".
 *
 * Settling is event-driven (onDidChangeDiagnostics) with a poll fallback so
 * servers that never fire events still get an answer.
 */
async function waitForDiagnostics(
	uri: vscode.Uri,
	hash: number,
	timeoutMs: number,
): Promise<SettleResult> {
	ensureCacheInvalidator();
	const cacheKey = uri.toString();
	const cached = settleCache.get(cacheKey);
	if (cached && cached.hash === hash && cached.expiresAt > Date.now()) {
		return { outcome: cached.outcome, cached: true };
	}

	const deadline = Date.now() + timeoutMs;
	let prevKey: string | undefined;
	let lastChangedAt = 0;
	let sawNonEmpty = false;
	let hadEvents = false;
	let changes = 0;
	let done = false;
	let resolveOutcome!: (result: SettleResult) => void;
	const outcomePromise = new Promise<SettleResult>((resolve) => {
		resolveOutcome = resolve;
	});

	const finish = (outcome: SettleOutcome): void => {
		if (done) return;
		done = true;
		settleCache.set(cacheKey, {
			hash,
			outcome,
			expiresAt: Date.now() + SETTLE_CACHE_TTL_MS,
		});
		resolveOutcome({ outcome, cached: false });
	};

	const check = (): void => {
		const diags = vscode.languages.getDiagnostics(uri);
		const key = snapshotKey(diags);
		const now = Date.now();
		if (key !== prevKey) {
			prevKey = key;
			lastChangedAt = now;
			changes++;
			if (diags.length > 0) sawNonEmpty = true;
			return; // wait for a quiet period before judging
		}
		const quiet = now - lastChangedAt;
		if (diags.length > 0) {
			// A stable set of problems the server is actively reporting.
			if (quiet >= DIAGNOSTICS_STABLE_MS) finish("settled");
		} else if (sawNonEmpty) {
			// The server cleared problems it had reported — a confirmed
			// transition to clean.
			if (quiet >= DIAGNOSTICS_STABLE_MS) finish("settled");
		} else if (hadEvents) {
			// The server talked but only ever reported nothing. Give staged
			// analysis (e.g. Pylance: syntax then semantic) a longer window
			// before calling the file clean.
			if (quiet >= DIAGNOSTICS_EMPTY_CONFIRM_MS) finish("settled");
		}
	};

	const sub = vscode.languages.onDidChangeDiagnostics((event) => {
		if (!event.uris.some((u) => u.toString() === cacheKey)) return;
		hadEvents = true;
		check();
	});

	for (;;) {
		if (done) break;
		check();
		if (done) break;
		if (Date.now() >= deadline) {
			// Never satisfied a settle condition: either the snapshot kept
			// changing (churn) or nothing ever appeared (silence).
			finish(changes >= 2 ? "churn" : "silent");
			break;
		}
		await new Promise((resolve) => setTimeout(resolve, DIAGNOSTICS_POLL_MS));
	}
	sub.dispose();
	return outcomePromise;
}

/** Max time to wait for a stale open buffer to reload from disk (ms). */
const BUFFER_SYNC_MS = 2000;

/**
 * Wait until an open document's buffer matches the file on disk. VS Code
 * reloads non-dirty documents when they change externally; this polls until
 * that happens or the budget runs out.
 */
async function waitForBufferSync(
	doc: vscode.TextDocument,
	diskContent: string,
	timeoutMs: number,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (doc.getText() === diskContent) return;
		if (Date.now() >= deadline) return;
		await new Promise((resolve) => setTimeout(resolve, DIAGNOSTICS_POLL_MS));
	}
}

export interface CollectDiagnosticsOptions {
	/**
	 * Files to lint (absolute or workspace-relative). When omitted (or empty),
	 * all documents the language servers have already analyzed are included.
	 */
	paths?: string[];
	/** Least severe level to include (error > warning > info > hint). */
	severity?: DiagnosticSeverityName;
	/** Maximum rows to return (default 100, max 500). */
	limit?: number;
	/** Max wait for a freshly opened file's language server (default 4000ms). */
	timeoutMs?: number;
	/** Suffix for the "No problems found…" message, e.g. " in src/app.py". */
	scopeLabel?: string;
}

export interface DiagnosticsReport {
	/** Tool-style formatted text, ready to send to the model. */
	text: string;
	details: {
		errors: number;
		warnings: number;
		infos: number;
		hints: number;
		total: number;
		files: number;
		truncatedTo: number;
		/** True when the language server confirmed a settled state. */
		settled: boolean;
		/** True when an open editor buffer differs from the file on disk. */
		staleBuffer: boolean;
	};
	/** Paths that could not be opened (missing files). */
	missing: string[];
}

/**
 * Collect and format diagnostics for a set of files (or all analyzed
 * documents). Mirrors how VS Code's own chat surfaces markers
 * (markersChatContext): group by file, prioritize the active editor file,
 * and show line:column positions.
 */
export async function collectDiagnostics(
	options: CollectDiagnosticsOptions = {},
): Promise<DiagnosticsReport> {
	const { paths, severity, limit, timeoutMs, scopeLabel } = options;
	const max = limit ? Math.min(Math.max(Math.trunc(limit), 1), 500) : 100;
	const floor = severity ? severityRank(severity) : severityRank("info");

	// Resolve targets: explicit paths (opened invisibly to trigger analysis)
	// or every document the language servers have already analyzed.
	let entries: Array<[vscode.Uri, readonly vscode.Diagnostic[]]>;
	let missing: string[] = [];
	let settled = true;
	let staleBuffer = false;
	let churned = false;
	let silentFresh = false;
	if (paths && paths.length > 0) {
		const uris = paths.map((p) => resolveUri(p));
		const docs: vscode.TextDocument[] = [];
		for (const uri of uris) {
			try {
				docs.push(await vscode.workspace.openTextDocument(uri));
			} catch {
				missing.push(vscode.workspace.asRelativePath(uri, false));
			}
		}
		if (missing.length === paths.length) {
			throw new Error(`File not found: ${missing.join(", ")}`);
		}
		// Read the on-disk content once so the stale-buffer logic below can
		// compare without repeated disk I/O.
		const diskContent = await Promise.all(
			docs.map(async (doc) => {
				try {
					return new TextDecoder().decode(
						await vscode.workspace.fs.readFile(doc.uri),
					);
				} catch {
					return undefined; // unreadable — skip sync/flagging
				}
			}),
		);
		// The agent writes to disk via workspace.fs, but language servers
		// analyze the editor buffer. If the file is open in a tab, the buffer
		// may still hold the pre-edit content, so linting immediately would
		// miss the agent's changes. VS Code reloads non-dirty documents when
		// they change on disk — wait briefly for that so the analysis
		// reflects the saved file, not a stale snapshot.
		// One total budget shared by the buffer reload and the server settle,
		// so a slow reload can't stack on top of a slow server.
		const deadline = Date.now() + (timeoutMs ?? DIAGNOSTICS_TIMEOUT_MS);
		await Promise.all(
			docs.map((doc, i) => {
				const disk = diskContent[i];
				if (disk === undefined || doc.isDirty) return Promise.resolve();
				return doc.getText() === disk
					? Promise.resolve()
					: waitForBufferSync(
							doc,
							disk,
							Math.min(
								BUFFER_SYNC_MS,
								Math.max(0, deadline - Date.now()),
							),
						);
			}),
		);
		// Wait for each language server to finish analyzing its document
		// (parallel; already-analyzed files settle within ~400ms).
		const settleResults = await Promise.all(
			docs.map((doc) =>
				waitForDiagnostics(
					doc.uri,
					contentHash(doc.getText()),
					Math.max(0, deadline - Date.now()),
				),
			),
		);
		settled = settleResults.every((result) => result.outcome === "settled");
		churned = settleResults.some((result) => result.outcome === "churn");
		silentFresh = settleResults.some(
			(result) => result.outcome === "silent" && !result.cached,
		);
		entries = uris.map((uri) => [uri, vscode.languages.getDiagnostics(uri)]);
		// Still differing after the sync wait (dirty buffer, or the reload
		// never arrived)? Diagnostics reflect the buffer, not the saved file —
		// say so instead of letting a stale "clean" pass as truth.
		staleBuffer = docs.some(
			(doc, i) =>
				diskContent[i] !== undefined && doc.getText() !== diskContent[i],
		);
	} else {
		entries = vscode.languages.getDiagnostics();
	}

	// Collect rows per file, dropping everything below the severity floor.
	const rowsByFile = new Map<string, DiagnosticRow[]>();
	for (const [uri, diags] of entries) {
		if (!diags || diags.length === 0) continue;
		const rel = vscode.workspace.asRelativePath(uri, false);
		const rows: DiagnosticRow[] = [];
		for (const d of diags) {
			const sev = SEVERITY_NAMES[d.severity] ?? "info";
			// Keep everything at least as severe as the chosen level.
			if (severityRank(sev) > floor) continue;
			rows.push({
				sev,
				line: d.range.start.line + 1,
				col: d.range.start.character + 1,
				message: formatDiagnostic(d),
			});
		}
		if (rows.length > 0) rowsByFile.set(rel, rows);
	}

	if (rowsByFile.size === 0) {
		return {
			text: buildReportText(
				`No problems found${scopeLabel ?? ""} (severity: ${severity ?? "info"} or more severe).`,
				settled,
				staleBuffer,
				churned,
				silentFresh,
			),
			details: {
				errors: 0,
				warnings: 0,
				infos: 0,
				hints: 0,
				total: 0,
				files: 0,
				truncatedTo: 0,
				settled,
				staleBuffer,
			},
			missing,
		};
	}

	// Prioritize the file the user is looking at (VS Code chat does the
	// same); a scoped set has no active-file preference.
	const activeKey = paths && paths.length > 0
		? undefined
		: vscode.window.activeTextEditor?.document.uri
			? vscode.workspace.asRelativePath(
					vscode.window.activeTextEditor!.document.uri,
					false,
				)
			: undefined;
	const orderedFiles = [...rowsByFile.keys()].sort((a, b) => {
		if (activeKey && a === activeKey) return -1;
		if (activeKey && b === activeKey) return 1;
		return a.localeCompare(b);
	});

	// Errors first, then line, then column within a file.
	for (const rows of rowsByFile.values()) {
		rows.sort(
			(a, b) =>
				severityRank(a.sev) - severityRank(b.sev) ||
				a.line - b.line ||
				a.col - b.col,
		);
	}

	const counts = { error: 0, warning: 0, info: 0, hint: 0 };
	let total = 0;
	for (const rows of rowsByFile.values()) {
		for (const r of rows) {
			counts[r.sev]++;
			total++;
		}
	}

	const lines: string[] = [];
	const summary: string[] = [];
	for (const sev of DIAGNOSTIC_SEVERITIES) {
		if (counts[sev] > 0) {
			summary.push(`${counts[sev]} ${sev}${counts[sev] > 1 ? "s" : ""}`);
		}
	}
	lines.push(
		`Problems: ${summary.join(", ") || "none"} in ${rowsByFile.size} file${rowsByFile.size > 1 ? "s" : ""}`,
	);
	lines.push("");

	let shown = 0;
	let remainder = 0;
	let lastFile: string | undefined;
	for (const file of orderedFiles) {
		for (const r of rowsByFile.get(file)!) {
			if (shown >= max) {
				remainder++;
				continue;
			}
			if (file !== lastFile) {
				lines.push(`${file}:`);
				lastFile = file;
			}
			lines.push(`  ${r.sev.padEnd(7)} ${r.line}:${r.col}  ${r.message}`);
			shown++;
		}
	}
	if (remainder > 0) {
		lines.push(`\n(... and ${remainder} more — pass path/severity/limit to narrow)`);
	}

	return {
		text: buildReportText(
			lines.join("\n"),
			settled,
			staleBuffer,
			churned,
			silentFresh,
		),
		details: {
			errors: counts.error,
			warnings: counts.warning,
			infos: counts.info,
			hints: counts.hint,
			total,
			files: rowsByFile.size,
			truncatedTo: remainder > 0 ? max : total,
			settled,
			staleBuffer,
		},
		missing,
	};
}

/**
 * Append honest caveats to a report when the result may not be final:
 * - !settled → the language server never confirmed (fresh analysis may still
 *   be running), so a "clean" (or partial) result should be re-checked.
 * - staleBuffer → diagnostics reflect the open editor buffer, which differs
 *   from the file on disk (e.g. an agent write that hasn't reloaded yet).
 */
function buildReportText(
	text: string,
	settled: boolean,
	staleBuffer: boolean,
	churned: boolean,
	silentFresh: boolean,
): string {
	const notes: string[] = [];
	if (staleBuffer) {
		notes.push(
			"Note: the open editor buffer differs from the file on disk — these diagnostics reflect the buffer, not the saved file.",
		);
	}
	if (!settled) {
		if (churned) {
			// The server is actively changing its results — genuinely
			// unresolved, worth an explicit re-run.
			notes.push(
				"Note: the language server kept updating its diagnostics and never settled on a final state — re-run get_diagnostics to confirm.",
			);
		} else if (silentFresh) {
			// Nothing ever reported, and this is the first (uncached) check,
			// so the "clean" is only as good as the server's silence. Cached
			// re-runs skip this so a verified-clean file stops nagging.
			notes.push(
				"Note: no language server reported problems for this file — it may still be analyzing (re-run to confirm), or no extension is active for this file type.",
			);
		}
	}
	if (notes.length === 0) return text;
	return `${text}\n${notes.join("\n")}`;
}
