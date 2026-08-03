/**
 * CodePi editor-context collection.
 *
 * Shared by the `codepi-context` bundled extension (tools read the VS Code API
 * through the `globalThis.__codepiVscode` bridge set by the host) and the host
 * itself (`createRuntime` renders the session-start `<editor_context>` snapshot
 * and injects it into pi's system prompt via `appendSystemPromptOverride`).
 *
 * This module is deliberately pure: it imports nothing from `vscode`, pi, or
 * typebox — the VS Code API object is passed in (the real `vscode` from the
 * host, the bridged value in pi-land, or a mock in tests). That keeps it
 * bundle-safe for both esbuild (host) and jiti (pi extension loader).
 *
 * Every section is collected defensively: a failure in one section never fails
 * the whole snapshot — it lands in `errors` and the section degrades (e.g.
 * `git: unavailable`).
 */
import { readFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

// ── Limits ──────────────────────────────────────────────────

/** Selections up to this many chars are inlined into the snapshot. */
export const SELECTION_TEXT_MAX = 800;
/** Selections up to this many chars are inlined when includeSelection is true. */
export const SELECTION_TEXT_FORCED_MAX = 2000;
/** Cap for the open-editors list. */
export const OPEN_EDITORS_MAX = 30;
/** Cap for the git changed-files list (stats only computed up to this cap). */
export const GIT_FILES_MAX = 30;
/** Cap for the recent-file switches list. */
export const RECENT_FILES_MAX = 6;
/** Cap for a single full-diff file (get_git_diff). */
export const DIFF_LINES_MAX = 2000;
/** Overall cap for the combined get_git_diff output (keep the head). */
export const DIFF_TOTAL_MAX = 4000;
/** Per-repo git diff-stat cache TTL (each stat spawns a git subprocess). */
export const GIT_STATS_TTL_MS = 3000;
/**
 * Max time the session-start snapshot waits for the window to restore its
 * editor layout before collecting anyway (unknown state must never block
 * session creation).
 */
export const RESTORE_WAIT_MS = 1200;

/** Numeric `Status` codes from the vscode.git API v1 const enum. */
const GIT_STATUS_CODES: Record<number, string> = {
	0: "M", // INDEX_MODIFIED
	1: "A", // INDEX_ADDED
	2: "D", // INDEX_DELETED
	3: "R", // INDEX_RENAMED
	4: "C", // INDEX_COPIED
	5: "M", // MODIFIED
	6: "D", // DELETED
	7: "?", // UNTRACKED
	8: "!", // IGNORED
	9: "A", // INTENT_TO_ADD
	10: "R", // INTENT_TO_RENAME
	11: "T", // TYPE_CHANGED
	12: "A", // ADDED_BY_US
	13: "A", // ADDED_BY_THEM
	14: "D", // DELETED_BY_US
	15: "D", // DELETED_BY_THEM
	16: "M", // BOTH_ADDED
	17: "D", // BOTH_DELETED
	18: "M", // BOTH_MODIFIED
};

export interface EditorContextOptions {
	/** When true, always inline the selected text (up to SELECTION_TEXT_FORCED_MAX). When false/omitted, inline only short selections (≤ SELECTION_TEXT_MAX). */
	includeSelection?: boolean;
	/** Cap on the git changed-files list (default GIT_FILES_MAX). */
	maxFiles?: number;
	/** Compute per-file diff stats (+N/−M). Default true; each stat is a git subprocess → cached ~3s. */
	includeGitStats?: boolean;
}

export interface ChangeInfo {
	/** Path relative to the repo root. */
	path: string;
	/** Absolute path on disk. */
	absPath: string;
	/** Short status code (M/A/D/R/T/?). */
	status: string;
	/** True when the change is staged (index). */
	staged: boolean;
	/** True for untracked files. */
	untracked: boolean;
	/** +N/−M stats vs HEAD (not set for untracked). */
	insertions?: number;
	deletions?: number;
	/** Line count for untracked files. */
	lineCount?: number;
}

export interface GitRepoInfo {
	root: string;
	branch?: string;
	upstream?: string;
	ahead?: number;
	behind?: number;
	changes: ChangeInfo[];
}

export interface EditorContext {
	workspace: {
		folders: string[];
		name?: string;
		trusted: boolean;
	};
	active?: {
		path: string;
		languageId: string;
		line: number;
		col: number;
		lineCount: number;
		dirty: boolean;
	};
	/** Every deliberate selection across the active + visible editors. */
	selections: Array<{
		file: string;
		start: string;
		end: string;
		lines: number;
		text?: string;
	}>;
	openEditors: Array<{ path: string; active: boolean; dirty: boolean }>;
	recent: string[];
	git?: { available: boolean; repos: GitRepoInfo[]; reason?: string };
	scmInput?: string;
	terminals: string[];
	debug?: { name: string; type: string } | null;
	collectedAt: number;
	errors: string[];
}

// ── Recent-file tracker (module-level; one cache per module instance) ──

const recentFiles: Array<{ path: string; ts: number }> = [];
let tracking = false;

/** Subscribe to active-editor switches to build the "recent" list. Idempotent. */
export function trackContextEvents(vscode: any): void {
	if (tracking || !vscode?.window?.onDidChangeActiveTextEditor) return;
	tracking = true;
	try {
		vscode.window.onDidChangeActiveTextEditor((editor: any) => {
			const path = editor?.document?.uri?.fsPath;
			if (typeof path !== "string" || path.length === 0) return;
			const ts = Date.now();
			recentFiles.unshift({ path, ts });
			// Drop duplicates (keep the newest) and cap the list.
			for (let i = 1; i < recentFiles.length; i++) {
				if (recentFiles[i].path === path) recentFiles.splice(i--, 1);
			}
			while (recentFiles.length > RECENT_FILES_MAX) recentFiles.pop();
			// Only keep entries from the last 30 minutes — stale switches aren't context.
			const cutoff = ts - 30 * 60 * 1000;
			while (
				recentFiles.length > 0 &&
				recentFiles[recentFiles.length - 1].ts < cutoff
			) {
				recentFiles.pop();
			}
		});
	} catch {
		/* events unavailable — recent list stays empty */
	}
}

/** Most-recent active-editor switches (paths), newest first. */
export function getRecentFiles(): string[] {
	return recentFiles.map((f) => f.path);
}

/**
 * Test-only: clear the module-level tracker and git-stats caches so tests
 * don't leak state between cases.
 */
export function __resetContextStateForTests(): void {
	recentFiles.length = 0;
	tracking = false;
	gitStatsCache.clear();
}

// ── Small helpers ───────────────────────────────────────────

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Path relative to `cwd` when inside it, absolute otherwise. */
function displayPath(cwd: string, abs: string): string {
	try {
		const rel = relative(cwd, abs);
		if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) return rel;
	} catch {
		/* different drive / invalid path */
	}
	return abs;
}

/** Collapse whitespace and newlines into a single-line quote. */
function inline(text: string, max: number): string {
	const one = text.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
	if (one.length <= max) return one;
	return one.slice(0, Math.max(0, max - 1)) + "…";
}

function selectionLabel(line: number, col: number): string {
	return `L${line}:${col}`;
}

// ── Git collection ──────────────────────────────────────────

const gitStatsCache = new Map<
	string,
	{ at: number; insertions: number; deletions: number }
>();

async function countLines(absPath: string): Promise<number | undefined> {
	try {
		const content = await readFile(absPath, "utf8");
		return content.split("\n").length;
	} catch {
		return undefined;
	}
}

async function gitStatsFor(
	repo: any,
	root: string,
	relPath: string,
): Promise<{ insertions: number; deletions: number } | undefined> {
	const key = `${root}:${relPath}`;
	const hit = gitStatsCache.get(key);
	if (hit && Date.now() - hit.at < GIT_STATS_TTL_MS) {
		return { insertions: hit.insertions, deletions: hit.deletions };
	}
	try {
		const stats = await repo.diffWithHEADShortStats(relPath);
		const insertions = stats?.insertions ?? 0;
		const deletions = stats?.deletions ?? 0;
		// A real change always has at least one +/- line; 0/0 means the shortstat
		// returned nothing (transient failure or no diff) — don't cache it.
		if (insertions === 0 && deletions === 0) return undefined;
		const result = { insertions, deletions };
		gitStatsCache.set(key, { at: Date.now(), ...result });
		return result;
	} catch {
		return undefined;
	}
}

/** Pick the repository whose root contains `cwd` (longest match). */
function pickRepo(repositories: any[] | undefined, cwd: string): any | undefined {
	if (!Array.isArray(repositories)) return undefined;
	const resolved = resolve(cwd);
	let best: any | undefined;
	let bestLength = -1;
	for (const repo of repositories) {
		const root = repo?.rootUri?.fsPath;
		if (typeof root !== "string") continue;
		if (resolved === root || resolved.startsWith(root + "/") || resolved.startsWith(root + "\\")) {
			if (root.length > bestLength) {
				best = repo;
				bestLength = root.length;
			}
		}
	}
	return best;
}

interface ResolvedGit {
	repo: any;
	root: string;
}

async function resolveGit(vscode: any, cwd: string): Promise<ResolvedGit | undefined> {
	const gitExtension = vscode?.extensions?.getExtension?.("vscode.git");
	const api = gitExtension?.exports?.getAPI?.(1);
	if (!api) return undefined;
	const repo =
		api.getRepository?.(vscode.Uri.file(cwd)) ?? pickRepo(api.repositories, cwd);
	const root = repo?.rootUri?.fsPath;
	if (typeof root !== "string") return undefined;
	return { repo, root };
}

/** List changed files (working tree + index + untracked), deduped by path. */
async function listRepoChanges(
	repo: any,
	root: string,
	maxFiles: number,
	includeStats: boolean,
): Promise<ChangeInfo[]> {
	const state = repo?.state ?? {};
	const entries: Array<{
		uri: any;
		status: number | undefined;
		staged: boolean;
		untracked: boolean;
	}> = [];
	const push = (list: any[] | undefined, staged: boolean, untracked: boolean) => {
		if (!Array.isArray(list)) return;
		for (const c of list) {
			entries.push({ uri: c?.uri, status: c?.status, staged, untracked });
		}
	};
	push(state.workingTreeChanges, false, false);
	push(state.indexChanges, true, false);
	push(state.untrackedChanges, false, true);

	const byPath = new Map<string, ChangeInfo>();
	for (const entry of entries) {
		const absPath = entry.uri?.fsPath;
		if (typeof absPath !== "string") continue;
		let relPath: string;
		try {
			relPath = relative(root, absPath);
		} catch {
			continue;
		}
		if (relPath.startsWith("..") || isAbsolute(relPath)) continue;
		const existing = byPath.get(relPath);
		if (existing) {
			if (entry.staged && !existing.staged) existing.staged = true;
			continue;
		}
		byPath.set(relPath, {
			path: relPath,
			absPath,
			status: GIT_STATUS_CODES[entry.status ?? 7] ?? "?",
			staged: entry.staged,
			untracked: entry.untracked,
		});
	}

	const changes = Array.from(byPath.values());
	// Cap the stats work (each stat is a subprocess), but keep the full list.
	const statted = changes.slice(0, maxFiles);
	if (includeStats) {
		await Promise.all(
			statted.map(async (ch) => {
				if (ch.untracked) {
					ch.lineCount = await countLines(ch.absPath);
				} else {
					const stats = await gitStatsFor(repo, root, ch.path);
					if (stats) {
						ch.insertions = stats.insertions;
						ch.deletions = stats.deletions;
					}
				}
			}),
		);
	}
	return changes;
}

async function collectGit(
	vscode: any,
	cwd: string,
	maxFiles: number,
	includeStats: boolean,
): Promise<{ available: boolean; repos: GitRepoInfo[]; reason?: string }> {
	const gitExtension = vscode?.extensions?.getExtension?.("vscode.git");
	const api = gitExtension?.exports?.getAPI?.(1);
	if (!gitExtension || !api) {
		return { available: false, repos: [], reason: "vscode.git unavailable" };
	}
	const repo = api.getRepository?.(vscode.Uri.file(cwd)) ?? pickRepo(api.repositories, cwd);
	if (!repo) {
		return { available: false, repos: [], reason: "not a git repository" };
	}
	const root = repo?.rootUri?.fsPath;
	if (typeof root !== "string") {
		return { available: false, repos: [], reason: "not a git repository" };
	}
	const state = repo.state ?? {};
	const head = state.HEAD;
	const changes = await listRepoChanges(repo, root, maxFiles, includeStats);
	return {
		available: true,
		repos: [
			{
				root,
				branch: head?.name,
				upstream: head?.upstream?.name,
				ahead: head?.ahead,
				behind: head?.behind,
				changes,
			},
		],
	};
}

// ── Collection ──────────────────────────────────────────────

type SelectionInfo = {
	file: string;
	start: string;
	end: string;
	lines: number;
	text?: string;
};

/**
 * True when a selection is deliberate enough to surface from a NON-active
 * editor (multi-line, or a multi-char drag). The active editor's selection is
 * always surfaced regardless.
 */
function isDeliberateSelection(sel: any): boolean {
	if (!sel || sel.isEmpty) return false;
	return (
		sel.end.line !== sel.start.line ||
		sel.end.character - sel.start.character >= 3
	);
}

/**
 * Collect every deliberate selection across the active + visible editors.
 * Each entry carries its file, so selections in different files are
 * unambiguous — the standard, non-hacky way to keep seeing what the user
 * highlighted even when the CodePi panel has focus (activeTextEditor is
 * undefined then, but visible editors still expose `.selection`).
 */
function collectSelections(
	vscode: any,
	includeSelection: boolean,
): SelectionInfo[] {
	const result: SelectionInfo[] = [];
	const seen = new Set<string>();
	const activeEditor = vscode?.window?.activeTextEditor;
	const visible: any[] = vscode?.window?.visibleTextEditors ?? [];
	const editors = [activeEditor, ...visible].filter(
		(editor): editor is any => !!editor?.document?.uri?.fsPath,
	);
	for (const editor of editors) {
		const path = editor.document.uri.fsPath;
		const sel = editor.selection;
		if (editor !== activeEditor && !isDeliberateSelection(sel)) continue;
		if (!sel || sel.isEmpty) continue;
		if (seen.has(path)) continue;
		seen.add(path);
		const startLine = sel.start.line + 1;
		const endLine = sel.end.line + 1;
		let text: string | undefined;
		const fullText = editor.document.getText(sel);
		const limit = includeSelection
			? SELECTION_TEXT_FORCED_MAX
			: SELECTION_TEXT_MAX;
		if (typeof fullText === "string" && fullText.length > 0) {
			if (fullText.length <= limit) {
				text = fullText;
			} else if (includeSelection) {
				text = fullText.slice(0, limit) + "…";
			}
		}
		result.push({
			file: path,
			start: selectionLabel(startLine, sel.start.character + 1),
			end: selectionLabel(endLine, sel.end.character + 1),
			lines: Math.max(1, endLine - startLine + 1),
			text,
		});
	}
	return result;
}

/**
 * The primary editor for the `active:` line: the active one, else the first
 * visible editor that holds a selection (panel-focused case).
 */
function pickPrimaryEditor(vscode: any, selections: SelectionInfo[]): any | undefined {
	const active = vscode?.window?.activeTextEditor;
	if (active?.document?.uri?.fsPath) return active;
	if (selections.length === 0) return undefined;
	const path = selections[0].file;
	const visible: any[] = vscode?.window?.visibleTextEditors ?? [];
	return visible.find((editor: any) => editor?.document?.uri?.fsPath === path);
}

/** Collect the current editor/workspace/git context. Never throws. */
export async function collectEditorContext(
	vscode: any,
	cwd: string,
	options: EditorContextOptions = {},
): Promise<EditorContext> {
	const errors: string[] = [];
	const maxFiles = options.maxFiles ?? GIT_FILES_MAX;
	const includeSelection = options.includeSelection ?? false;
	const includeGitStats = options.includeGitStats ?? true;

	// Workspace
	let folders: string[] = [];
	let workspaceName: string | undefined;
	let trusted = false;
	try {
		const workspaceFolders = vscode?.workspace?.workspaceFolders;
		if (Array.isArray(workspaceFolders)) {
			folders = workspaceFolders
				.map((f: any) => f?.uri?.fsPath)
				.filter((p: unknown): p is string => typeof p === "string");
		}
		trusted = !!vscode?.workspace?.isTrusted;
		workspaceName =
			typeof vscode?.workspace?.name === "string"
				? vscode.workspace.name
				: undefined;
	} catch (err) {
		errors.push(`workspace: ${errorMessage(err)}`);
	}

	// Active editor + selections. When nothing is active (CodePi panel
	// focused), the primary editor falls back to the first visible editor
	// holding a selection, and every deliberate selection across visible
	// editors is reported with its own file.
	let active: EditorContext["active"];
	let selections: SelectionInfo[] = [];
	try {
		selections = collectSelections(vscode, includeSelection);
		const editor = pickPrimaryEditor(vscode, selections);
		const document = editor?.document;
		if (editor && document?.uri?.fsPath) {
			const sel = editor.selection;
			active = {
				path: document.uri.fsPath,
				languageId:
					typeof document.languageId === "string" ? document.languageId : "",
				line: (sel?.active?.line ?? 0) + 1,
				col: (sel?.active?.character ?? 0) + 1,
				lineCount:
					typeof document.lineCount === "number" ? document.lineCount : 0,
				dirty: !!document.isDirty,
			};
		}
	} catch (err) {
		errors.push(`activeEditor: ${errorMessage(err)}`);
	}

	// Open editors (tabs). When the tab model is unavailable or still empty
	// (the window is restoring its layout at session start), fall back to the
	// workspace's open text documents so the list is never spuriously empty.
	let openEditors: EditorContext["openEditors"] = [];
	try {
		const tabs: any[] = vscode?.window?.tabs ?? [];
		if (Array.isArray(tabs) && tabs.length > 0) {
			const activeInput = vscode?.window?.tabGroups?.activeTabGroup?.activeTab?.input;
			for (const tab of tabs) {
				const input = tab?.input;
				const uri = input?.uri;
				if (typeof uri?.fsPath !== "string") continue;
				const active = input === activeInput;
				openEditors.push({
					path: uri.fsPath,
					active,
					dirty: !!tab.isDirty,
				});
			}
		}
		if (openEditors.length === 0) {
			const activePath = vscode?.window?.activeTextEditor?.document?.uri?.fsPath;
			const docs: any[] = vscode?.workspace?.textDocuments ?? [];
			if (Array.isArray(docs)) {
				for (const doc of docs) {
					const uri = doc?.uri;
					if (uri?.scheme !== "file") continue;
					if (typeof uri?.fsPath !== "string") continue;
					// Dedupe — a restored document can also be reported by tabs.
					if (openEditors.some((e) => e.path === uri.fsPath)) continue;
					openEditors.push({
						path: uri.fsPath,
						active: uri.fsPath === activePath,
						dirty: !!doc.isDirty,
					});
				}
			}
		}
	} catch (err) {
		errors.push(`openEditors: ${errorMessage(err)}`);
	}

	// Recent switches
	const recent = getRecentFiles();

	// Git
	let git: EditorContext["git"];
	try {
		git = await collectGit(vscode, cwd, maxFiles, includeGitStats);
	} catch (err) {
		git = { available: false, repos: [], reason: errorMessage(err) };
		errors.push(`git: ${errorMessage(err)}`);
	}

	// SCM commit box
	let scmInput: string | undefined;
	try {
		const value = vscode?.scm?.inputBox?.value;
		if (typeof value === "string" && value.trim().length > 0) {
			scmInput = value.trim();
		}
	} catch (err) {
		errors.push(`scm: ${errorMessage(err)}`);
	}

	// Terminals
	let terminals: string[] = [];
	try {
		terminals = (vscode?.window?.terminals ?? [])
			.map((t: any) => t?.name)
			.filter((n: unknown): n is string => typeof n === "string");
	} catch (err) {
		errors.push(`terminals: ${errorMessage(err)}`);
	}

	// Debug session
	let debug: EditorContext["debug"];
	try {
		const session = vscode?.debug?.activeDebugSession;
		debug = session ? { name: session.name, type: session.type } : null;
	} catch (err) {
		debug = null;
		errors.push(`debug: ${errorMessage(err)}`);
	}

	return {
		workspace: { folders, name: workspaceName, trusted },
		active,
		selections,
		openEditors,
		recent,
		git,
		scmInput,
		terminals,
		debug,
		collectedAt: Date.now(),
		errors,
	};
}

// ── Formatting ──────────────────────────────────────────────

function formatGitSection(repos: GitRepoInfo[]): string[] {
	if (repos.length === 0) return ["git: clean"];
	const multi = repos.length > 1;
	const lines: string[] = [];
	for (const repo of repos) {
		const head = repo.branch ?? "detached";
		const divergence: string[] = [];
		if (repo.ahead) divergence.push(`ahead ${repo.ahead}`);
		if (repo.behind) divergence.push(`behind ${repo.behind}`);
		const headSuffix = divergence.length > 0 ? ` (${divergence.join(", ")})` : "";
		const prefix = multi ? `${basename(repo.root)}: ` : "";
		if (repo.changes.length === 0) {
			lines.push(`git: ${prefix}${head}${headSuffix} — clean`);
			continue;
		}
		const shown = repo.changes.slice(0, GIT_FILES_MAX);
		const entries = shown.map((c) => {
			if (c.untracked) return `${c.path} (new, ${c.lineCount ?? "?"} lines)`;
			if (c.insertions !== undefined || c.deletions !== undefined) {
				return `${c.path} +${c.insertions ?? 0}/−${c.deletions ?? 0}`;
			}
			return `${c.path} ${c.status}`;
		});
		const more =
			repo.changes.length > GIT_FILES_MAX
				? ` … +${repo.changes.length - GIT_FILES_MAX} more`
				: "";
		lines.push(
			`git: ${prefix}${head}${headSuffix} — ${repo.changes.length} changed: ${entries.join(", ")}${more}`,
		);
	}
	return lines;
}

/**
 * Compact per-turn context (active file + selection) injected by the
 * codepi-context extension's before_agent_start handler so the agent sees the
 * current editor state even after the session-start snapshot goes stale.
 * Returns "" when there is no active editor.
 */
export function formatLiveContext(ctx: EditorContext, cwd: string): string {
	if (!ctx.active) return "";
	const lines: string[] = [];
	const { path, languageId, line, col, lineCount, dirty } = ctx.active;
	let active = `active: ${displayPath(cwd, path)} [${languageId}] L${line}:${col}`;
	if (dirty) active += " (dirty)";
	active += ` (${lineCount} lines)`;
	lines.push(active);
	lines.push(...formatSelections(ctx.selections, cwd, 200));
	return `<live_editor_context>\n${lines.join("\n")}\n</live_editor_context>`;
}

/** One range line + one text line per selection, each tagged with its file. */
function formatSelections(
	selections: EditorContext["selections"],
	cwd: string,
	maxTextWidth: number,
): string[] {
	const lines: string[] = [];
	for (const sel of selections) {
		const file = displayPath(cwd, sel.file);
		lines.push(
			`selection: ${file} ${sel.start}–${sel.end} (${sel.lines} line${sel.lines === 1 ? "" : "s"})`,
		);
		if (sel.text) {
			lines.push(`selection_text: ${inline(sel.text, maxTextWidth)}`);
		}
	}
	return lines;
}

/** Render the collected context as the `<editor_context>` block. */
export function formatContextSnapshot(
	ctx: EditorContext,
	cwd: string,
	options: { fresh?: boolean } = {},
): string {
	const lines: string[] = [];
	const { folders, trusted } = ctx.workspace;

	if (folders.length === 0) {
		lines.push("workspace: <no folder open>");
	} else if (folders.length === 1) {
		const label = displayPath(cwd, folders[0]);
		const nameSuffix =
			typeof ctx.workspace.name === "string" && ctx.workspace.name.length > 0
				? ` (${ctx.workspace.name})`
				: "";
		lines.push(
			`workspace: ${label}${nameSuffix}${trusted ? "" : " (untrusted)"}`,
		);
	} else {
		lines.push(
			`workspace: ${folders.length} folders${trusted ? "" : " (untrusted)"}: ${folders.map((f) => displayPath(cwd, f)).join(", ")}`,
		);
	}

	if (ctx.active) {
		lines.push(
			`active: ${displayPath(cwd, ctx.active.path)} [${ctx.active.languageId}] L${ctx.active.line}:${ctx.active.col}${ctx.active.dirty ? " (dirty)" : ""} (${ctx.active.lineCount} lines)`,
		);
	}
	lines.push(...formatSelections(ctx.selections, cwd, 160));

	if (ctx.openEditors.length > 0) {
		const shown = ctx.openEditors.slice(0, OPEN_EDITORS_MAX);
		const parts = shown.map((e) => {
			const label = displayPath(cwd, e.path);
			return `${e.active ? "*" : ""}${label}${e.dirty ? " (dirty)" : ""}`;
		});
		if (ctx.openEditors.length > OPEN_EDITORS_MAX) {
			parts.push(`… +${ctx.openEditors.length - OPEN_EDITORS_MAX} more`);
		}
		lines.push(`open(${ctx.openEditors.length}): ${parts.join(", ")}`);
	}

	if (ctx.recent.length > 0) {
		const labels = ctx.recent
			.slice(0, RECENT_FILES_MAX)
			.map((p) => displayPath(cwd, p));
		lines.push(`recent: ${labels.join(" → ")}`);
	}

	if (ctx.git) {
		if (!ctx.git.available) {
			lines.push(
				`git: unavailable${ctx.git.reason ? ` (${ctx.git.reason})` : ""}`,
			);
		} else {
			lines.push(...formatGitSection(ctx.git.repos));
		}
	}

	if (ctx.scmInput) {
		lines.push(`scm_input: "${inline(ctx.scmInput, 120)}"`);
	}

	// Only report terminals/debug when there is something to report — empty
	// placeholders add no context.
	const statusBits: string[] = [];
	if (ctx.terminals.length > 0) {
		statusBits.push(
			`terminals: ${ctx.terminals.length} (${ctx.terminals.map((t) => inline(t, 30)).join(", ")})`,
		);
	}
	if (ctx.debug) {
		statusBits.push(`debug: ${inline(ctx.debug.name, 60)} (${ctx.debug.type})`);
	}
	if (statusBits.length > 0) {
		lines.push(statusBits.join("  "));
	}

	lines.push(
		options.fresh
			? "note: live editor state"
			: "note: snapshot from session start — call get_editor_context for live state",
	);

	return `<editor_context>\n${lines.join("\n")}\n</editor_context>`;
}

// ── Full diffs (get_git_diff) ───────────────────────────────

function truncateDiffLines(text: string, maxLines: number): string {
	const lines = text.split("\n");
	if (lines.length <= maxLines) return text;
	return (
		lines.slice(0, maxLines).join("\n") +
		`\n… diff truncated to ${maxLines} lines …`
	);
}

/** Unified diffs (vs HEAD) for the changed files; untracked files inlined. */
export async function collectGitDiffs(
	vscode: any,
	cwd: string,
	options: { path?: string; maxFiles?: number; maxDiffLines?: number } = {},
): Promise<string> {
	const git = await resolveGit(vscode, cwd);
	if (!git) return "(git unavailable)";
	const { repo, root } = git;
	const changes = await listRepoChanges(
		repo,
		root,
		options.maxFiles ?? GIT_FILES_MAX,
		false, // stats already available via the context tool; keep diffs fast
	);
	const maxDiffLines = options.maxDiffLines ?? DIFF_LINES_MAX;
	const targets = options.path
		? changes.filter((c) => {
				const wanted = resolve(cwd, options.path!);
				return (
					c.path === options.path ||
					c.absPath === wanted ||
					c.path.endsWith(`/${options.path}`)
				);
			})
		: changes.slice(0, options.maxFiles ?? GIT_FILES_MAX);

	if (targets.length === 0) {
		return options.path
			? `(no changes for ${options.path})`
			: "(no changed files)";
	}

	const parts: string[] = [];
	for (const change of targets) {
		let content: string;
		if (change.untracked) {
			try {
				content = `# new file: ${change.path} (untracked)\n${await readFile(change.absPath, "utf8")}`;
			} catch {
				continue;
			}
		} else {
			try {
				const raw = await repo.diffWithHEAD(change.path);
				content =
					typeof raw === "string"
						? raw
						: `(no diff for ${change.path})`;
			} catch {
				continue;
			}
		}
		parts.push(truncateDiffLines(content, maxDiffLines));
	}

	const joined = parts.join("\n\n");
	const totalLines = joined.split("\n").length;
	if (totalLines <= DIFF_TOTAL_MAX) return joined;
	const keep = joined.split("\n").slice(0, DIFF_TOTAL_MAX).join("\n");
	return `${keep}\n… diff output truncated to ${DIFF_TOTAL_MAX} lines …`;
}

// ── Host helper ─────────────────────────────────────────────

/**
 * Wait (bounded) until VS Code has restored its editor layout. At the very
 * start of a window, `window.tabs` and `workspace.textDocuments` can still be
 * empty while the user's files are being restored; collecting the session
 * snapshot then would report "no open editors". Polls cheaply and resolves as
 * soon as any tab or file-backed document appears, or when the timeout elapses
 * (unknown state must never block session creation).
 */
export function waitForEditorRestore(
	vscode: any,
	timeoutMs = RESTORE_WAIT_MS,
	pollMs = 75,
): Promise<void> {
	const hasEditors = (): boolean => {
		try {
			const tabs: unknown = vscode?.window?.tabs;
			if (Array.isArray(tabs) && tabs.length > 0) return true;
			const docs: unknown = vscode?.workspace?.textDocuments;
			return (
				Array.isArray(docs) &&
				docs.some(
					(d: any) =>
						d?.uri?.scheme === "file" && typeof d?.uri?.fsPath === "string",
				)
			);
		} catch {
			/* API unavailable — don't block */
		}
		return false;
	};
	return new Promise((resolve) => {
		if (hasEditors()) return resolve();
		const deadline = Date.now() + Math.max(0, timeoutMs);
		const timer = setInterval(() => {
			if (hasEditors() || Date.now() >= deadline) {
				clearInterval(timer);
				resolve();
			}
		}, Math.max(1, pollMs));
	});
}

/**
 * Render the system-prompt snapshot for a freshly created session. Returns
 * undefined (never throws) when collection fails or the API is unavailable.
 */
export async function renderSystemPromptSnapshot(
	vscode: any,
	cwd: string,
	options?: EditorContextOptions & { waitForRestore?: boolean },
): Promise<string | undefined> {
	try {
		if (!vscode?.window) return undefined;
		if (options?.waitForRestore) await waitForEditorRestore(vscode);
		const ctx = await collectEditorContext(vscode, cwd, options);
		return formatContextSnapshot(ctx, cwd);
	} catch {
		return undefined;
	}
}
