/**
 * Editor integration for edit review, mirroring VS Code Copilot's inline
 * review UI using only public extension APIs.
 *
 * Rendered per pending file (matching VS Code Copilot's inline review):
 *  - Green whole-line decorations on the PROPOSED lines (the new content on
 *    disk, i.e. what Accept keeps).
 *  - Below each green block, a red struck-through reference with the ORIGINAL
 *    line (what the file used to be — what Decline would restore). Pure
 *    insertions have no reference; pure deletions show only the reference.
 *  - Per-hunk AND top-of-file CodeLens actions as the clickable surface
 *    (whenever `editor.codeLens` is enabled): Accept All · Reject All ·
 *    Open Diff at the top of the file, Accept/Reject/Open Diff per hunk.
 *
 * VS Code has no public API for floating overlay widgets (Copilot's
 * `DiffHunkWidget` + multi-line view zones are internal), so decorations +
 * CodeLens are the closest public equivalent: the red reference is a `before`
 * attachment on the line below the green block (Copilot's view zone renders
 * the original lines in-place; the public `before` content is single-line,
 * truncated to the first line of the old content).
 */

import * as vscode from "vscode";
import type { EditProposal } from "./types";
import { splitLines } from "./diff";

export interface ReviewActionHandlers {
	acceptHunk(proposalId: string, hunkId: string): Promise<void>;
	rejectHunk(proposalId: string, hunkId: string): Promise<void>;
	acceptFile(proposalId: string): Promise<void>;
	rejectFile(proposalId: string): Promise<void>;
	openDiff(proposalId: string): Promise<void>;
}

/** Escape text for use inside a `before` contentText (HTML). */
function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

export class ReviewDecorations {
	private readonly added: vscode.TextEditorDecorationType;
	/** Red struck-through reference block of the ORIGINAL lines (before-only). */
	private readonly removedRef: vscode.TextEditorDecorationType;

	private readonly proposalsByUri = new Map<string, EditProposal>();
	private readonly decoratedEditors = new Set<vscode.TextEditor>();
	private codeLens: vscode.Disposable | undefined;
	private codeLensTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly disposables: vscode.Disposable[] = [];

	constructor() {
		this.added = vscode.window.createTextEditorDecorationType({
			isWholeLine: true,
			backgroundColor: new vscode.ThemeColor(
				"diffEditor.insertedTextBackground",
			),
			gutterIconPath: vscode.Uri.parse(
				`data:image/svg+xml,${encodeURIComponent(
					`<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12"><rect x="2" y="2" width="8" height="8" rx="1" fill="#4ec9b0"/></svg>`,
				)}`,
			),
			overviewRulerColor: new vscode.ThemeColor(
				"diffEditor.insertedTextBackground",
			),
			overviewRulerLane: vscode.OverviewRulerLane.Left,
		});
		// Red reference block: renders ONLY the before-content (the original
		// lines) — no line background, gutter, or border on the anchor line
		// itself. Colors mirror the diff editor's deleted-text styling
		// (background + line-through, like .inline-deleted-text in vscode).
		this.removedRef = vscode.window.createTextEditorDecorationType({
			overviewRulerColor: new vscode.ThemeColor(
				"diffEditor.removedTextBackground",
			),
			overviewRulerLane: vscode.OverviewRulerLane.Left,
		});

		// Keep decorations in sync with the active editor and its document.
		this.disposables.push(
			vscode.window.onDidChangeActiveTextEditor(() => this.refresh()),
			vscode.window.onDidChangeVisibleTextEditors(() => this.refresh()),
			vscode.workspace.onDidCloseTextDocument((doc) => {
				const uri = doc.uri.toString();
				if (this.proposalsByUri.has(uri)) this.refresh();
			}),
			vscode.workspace.onDidChangeTextDocument((e) => {
				if (this.proposalsByUri.has(e.document.uri.toString())) {
					this.refresh();
				}
			}),
			this.added,
			this.removedRef,
		);

		// Register the CodeLens provider for the whole-file and per-hunk
		// actions (visible when `editor.codeLens` is enabled). VS Code has no
		// public "refresh code lens" command; the controller re-queries when the
		// set of registered providers changes, so we re-register on state changes.
		this.registerCodeLens();
	}

	/**
	 * Provide CodeLens actions. Called by VS Code on demand; we also re-register
	 * the provider to force a refresh after review state changes.
	 */
	private provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
		const proposal = this.proposalsByUri.get(document.uri.toString());
		if (!proposal || proposal.status !== "pending") return [];
		const lenses: vscode.CodeLens[] = [];
		const pendingHunks = proposal.hunks.filter((h) => h.status === "pending");
		if (pendingHunks.length > 0) {
			// Whole-file question at the top of the file.
			const top = new vscode.Range(0, 0, 0, 0);
			lenses.push(
				new vscode.CodeLens(top, {
					title: `$(check-all) Accept All (${pendingHunks.length})`,
					command: "codepi.acceptFile",
					arguments: [proposal.proposalId],
				}),
				new vscode.CodeLens(top, {
					title: "$(discard) Reject All",
					command: "codepi.rejectFile",
					arguments: [proposal.proposalId],
				}),
				new vscode.CodeLens(top, {
					title: "$(diff) Open Diff",
					command: "codepi.openDiff",
					arguments: [proposal.proposalId],
				}),
			);
		}
		for (const hunk of pendingHunks) {
			const start = new vscode.Position(
				Math.max(0, hunk.modifiedStartLine - 1),
				0,
			);
			const end = new vscode.Position(
				Math.max(hunk.modifiedStartLine, hunk.modifiedEndLine) - 1,
				0,
			);
			const range = new vscode.Range(start, end);
			lenses.push(
				new vscode.CodeLens(range, {
					title: "$(check) Accept",
					command: "codepi.acceptHunk",
					arguments: [proposal.proposalId, hunk.hunkId],
				}),
				new vscode.CodeLens(range, {
					title: "$(close) Reject",
					command: "codepi.rejectHunk",
					arguments: [proposal.proposalId, hunk.hunkId],
				}),
				new vscode.CodeLens(range, {
					title: "$(diff) Open Diff",
					command: "codepi.openDiff",
					arguments: [proposal.proposalId],
				}),
			);
		}
		return lenses;
	}

	/** Dispose the previous registration and re-register (forces a re-query). */
	private registerCodeLens(): void {
		try {
			this.codeLens?.dispose();
		} catch {
			/* ignore */
		}
		this.codeLens = vscode.languages.registerCodeLensProvider(
			{ scheme: "file" },
			{ provideCodeLenses: (doc) => this.provideCodeLenses(doc) },
		);
	}

	/** Debounce provider re-registration across bursts of editor changes. */
	private scheduleCodeLensRefresh(): void {
		if (this.codeLensTimer !== undefined) clearTimeout(this.codeLensTimer);
		this.codeLensTimer = setTimeout(() => {
			this.codeLensTimer = undefined;
			this.registerCodeLens();
		}, 100);
	}

	/** Register/refresh a proposal (call on create and on state changes). */
	setProposal(proposal: EditProposal): void {
		this.proposalsByUri.set(proposal.uri, proposal);
		this.refresh();
	}

	/** Remove a proposal (file resolved or disposed). */
	clearProposal(uri: string): void {
		this.proposalsByUri.delete(uri);
		this.refresh();
	}

	/** Re-apply decorations for all editors currently showing proposals. */
	refresh(): void {
		// Drop editors that are no longer visible.
		const visible = new Set(vscode.window.visibleTextEditors);
		for (const editor of this.decoratedEditors) {
			if (!visible.has(editor)) {
				editor.setDecorations(this.added, []);
				editor.setDecorations(this.removedRef, []);
				this.decoratedEditors.delete(editor);
			}
		}

		for (const editor of vscode.window.visibleTextEditors) {
			const proposal = this.proposalsByUri.get(editor.document.uri.toString());
			if (!proposal || proposal.status !== "pending") {
				// Proposal gone or fully resolved — actively clear leftovers so
				// the last accepted/rejected hunk's highlight disappears.
				editor.setDecorations(this.added, []);
				editor.setDecorations(this.removedRef, []);
				this.decoratedEditors.delete(editor);
				continue;
			}
			this.applyToEditor(editor, proposal);
			this.decoratedEditors.add(editor);
		}

		// Refresh CodeLens: VS Code re-queries when providers change, so
		// re-register our provider (no public refresh command exists).
		this.scheduleCodeLensRefresh();
	}

	private applyToEditor(
		editor: vscode.TextEditor,
		proposal: EditProposal,
	): void {
		const added: vscode.DecorationOptions[] = [];
		const removedRef: vscode.DecorationOptions[] = [];
		const lineCount = editor.document.lineCount;

		const pendingHunks = proposal.hunks.filter(
			(h) =>
				h.status === "pending" &&
				(h.oldText.length > 0 || h.newText.length > 0),
		);
		if (pendingHunks.length === 0) {
			editor.setDecorations(this.added, []);
			editor.setDecorations(this.removedRef, []);
			return;
		}

		for (const hunk of pendingHunks) {
			// Green: the PROPOSED lines — the new content sitting on disk (what
			// Accept keeps). Covers pure insertions and modifications.
			for (let ln = hunk.modifiedStartLine; ln <= hunk.modifiedEndLine; ln++) {
				if (ln > 0 && ln <= lineCount) {
					added.push({ range: new vscode.Range(ln - 1, 0, ln, 0) });
				}
			}

			// Red reference: the ORIGINAL lines, struck through, rendered
			// immediately BELOW the green block (what the file used to be —
			// what Decline would restore). The anchor line is the next real
			// line after the block; pure deletions (no green block) anchor at
			// the spot where the deleted lines were.
			if (hunk.oldText.length > 0) {
				const previewLines = splitLines(hunk.oldText);
				// The editor API renders before-contentText inline and only its
				// FIRST line (vscode truncates content to a CSS content string),
				// so multi-line old content degrades to a marked truncation.
				const first = previewLines[0] ?? "";
				const more = previewLines.length - 1;
				const preview = escapeHtml(first + (more > 0 ? `… +${more} more` : ""));
				const attachLine =
					hunk.newText.length === 0
						? Math.min(hunk.modifiedStartLine - 1, lineCount) // pure deletion
						: Math.min(hunk.modifiedEndLine, lineCount); // after the green block
				// IMPORTANT: DecorationOptions ranges must NOT be empty (the
				// docs' "range must not be empty" contract) — empty ranges are
				// silently dropped by VS Code, which hid the reference block.
				removedRef.push({
					range: new vscode.Range(attachLine, 0, attachLine, 1),
					renderOptions: {
						before: {
							contentText: preview,
							color: new vscode.ThemeColor("diffEditor.removedTextForeground"),
							backgroundColor: new vscode.ThemeColor(
								"diffEditor.removedTextBackground",
							),
							border:
								"1px solid var(--vscode-diffEditor-removedTextBorder, var(--vscode-diffEditor-removedTextBackground))",
							margin: "0 12px 2px 0",
							textDecoration: "line-through",
						},
					},
				});
			}
		}

		editor.setDecorations(this.added, added);
		editor.setDecorations(this.removedRef, removedRef);
	}

	dispose(): void {
		if (this.codeLensTimer !== undefined) clearTimeout(this.codeLensTimer);
		this.codeLensTimer = undefined;
		try {
			this.codeLens?.dispose();
		} catch {
			/* ignore */
		}
		this.codeLens = undefined;
		for (const editor of this.decoratedEditors) {
			editor.setDecorations(this.added, []);
			editor.setDecorations(this.removedRef, []);
		}
		this.decoratedEditors.clear();
		for (const d of this.disposables) {
			try {
				d.dispose();
			} catch {
				/* ignore */
			}
		}
		this.disposables.length = 0;
	}
}

/** Side-by-side diff via virtual documents (accurate deleted-line rendering). */
export async function openProposalDiff(proposal: EditProposal): Promise<void> {
	const originalUri = vscode.Uri.parse(
		`codepi-diff-original:${encodeURIComponent(proposal.uri)}`,
	);
	const modifiedUri = vscode.Uri.parse(
		`codepi-diff-modified:${encodeURIComponent(proposal.uri)}`,
	);

	const provider = new (class implements vscode.TextDocumentContentProvider {
		async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
			const isOriginal = uri.scheme === "codepi-diff-original";
			if (isOriginal) return proposal.originalContent;
			return proposal.proposedContent;
		}
	})();

	const reg = vscode.workspace.registerTextDocumentContentProvider(
		"codepi-diff-original",
		provider,
	);
	const reg2 = vscode.workspace.registerTextDocumentContentProvider(
		"codepi-diff-modified",
		provider,
	);

	const name = proposal.path.split(/[\\/]/).pop() || proposal.path;
	await vscode.commands.executeCommand(
		"vscode.diff",
		originalUri,
		modifiedUri,
		`${name} — proposed changes`,
	);

	// Keep providers alive while the diff is open; dispose shortly after.
	setTimeout(
		() => {
			reg.dispose();
			reg2.dispose();
		},
		5 * 60 * 1000,
	);
}

// Exported for tests/type safety.
