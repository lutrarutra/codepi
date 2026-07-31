/**
 * Editor integration for edit review, mirroring VS Code Copilot's inline
 * review UI using only public extension APIs.
 *
 * Rendered per pending file:
 *  - A "review bar" at the TOP of the file: `📝 N changes — Accept All ·
 *    Reject All · Open Diff`. Always visible via a line-1 decoration `before`
 *    attachment; hovering shows real clickable buttons (command links).
 *  - Green whole-line decorations on added lines.
 *  - Red whole-line decoration + struck-through preview for removed lines
 *    (anchored to the line following the deletion, since the public API cannot
 *    insert phantom lines into the layout).
 *  - An action pill `✓ Accept  ✕ Reject` at the END of each pending snippet,
 *    with clickable Accept/Reject buttons on hover.
 *  - Per-hunk AND top-of-file CodeLens actions as an extra clickable surface
 *    (whenever `editor.codeLens` is enabled).
 *
 * VS Code has no public API for floating overlay widgets (Copilot's
 * `DiffHunkWidget` is internal), so decorations + hover command links + CodeLens
 * are the closest public equivalent.
 */

import * as vscode from "vscode";
import type { EditProposal, EditHunk } from "./types";
import { splitLines, countHunkLines } from "./diff";

export interface ReviewActionHandlers {
	acceptHunk(proposalId: string, hunkId: string): Promise<void>;
	rejectHunk(proposalId: string, hunkId: string): Promise<void>;
	acceptFile(proposalId: string): Promise<void>;
	rejectFile(proposalId: string): Promise<void>;
	openDiff(proposalId: string): Promise<void>;
}

/** URL-encode JSON args for `command:...?...` links in markdown. */
function enc(args: unknown[]): string {
	return encodeURIComponent(JSON.stringify(args));
}

/** Append a clickable command link to a (trusted) hover markdown. */
function link(
	md: vscode.MarkdownString,
	title: string,
	command: string,
	args: unknown[],
): void {
	md.appendMarkdown(`[${title}](command:${command}?${enc(args)})&nbsp;&nbsp;`);
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
	private readonly removed: vscode.TextEditorDecorationType;
	private readonly modified: vscode.TextEditorDecorationType;
	private readonly reviewBar: vscode.TextEditorDecorationType;
	private readonly hunkActions: vscode.TextEditorDecorationType;

	private readonly proposalsByUri = new Map<string, EditProposal>();
	private readonly decoratedEditors = new Set<vscode.TextEditor>();
	private codeLens: vscode.Disposable | undefined;
	private codeLensTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly handlers: ReviewActionHandlers) {
		this.added = vscode.window.createTextEditorDecorationType({
			isWholeLine: true,
			backgroundColor: new vscode.ThemeColor("diffEditor.insertedTextBackground"),
			gutterIconPath: vscode.Uri.parse(
				`data:image/svg+xml,${encodeURIComponent(
					`<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12"><rect x="2" y="2" width="8" height="8" rx="1" fill="#4ec9b0"/></svg>`,
				)}`,
			),
			overviewRulerColor: new vscode.ThemeColor("diffEditor.insertedTextBackground"),
			overviewRulerLane: vscode.OverviewRulerLane.Left,
		});
		this.removed = vscode.window.createTextEditorDecorationType({
			isWholeLine: true,
			backgroundColor: new vscode.ThemeColor("diffEditor.removedTextBackground"),
			gutterIconPath: vscode.Uri.parse(
				`data:image/svg+xml,${encodeURIComponent(
					`<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12"><rect x="2" y="2" width="8" height="8" rx="1" fill="#f14c4c"/></svg>`,
				)}`,
			),
			overviewRulerColor: new vscode.ThemeColor("diffEditor.removedTextBackground"),
			overviewRulerLane: vscode.OverviewRulerLane.Left,
		});
		this.modified = vscode.window.createTextEditorDecorationType({
			isWholeLine: true,
			backgroundColor: new vscode.ThemeColor("diffEditor.diffFoldBackground"),
			gutterIconPath: vscode.Uri.parse(
				`data:image/svg+xml,${encodeURIComponent(
					`<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12"><rect x="2" y="2" width="8" height="8" rx="1" fill="#d7ba7d"/></svg>`,
				)}`,
			),
			overviewRulerColor: new vscode.ThemeColor("editor.findMatchHighlightBackground"),
			overviewRulerLane: vscode.OverviewRulerLane.Left,
		});
		// Top-of-file review bar and per-snippet action pills: attachments are
		// set per-decoration-item (see applyToEditor) so text/colors vary.
		this.reviewBar = vscode.window.createTextEditorDecorationType({
			isWholeLine: true,
		});
		this.hunkActions = vscode.window.createTextEditorDecorationType({
			isWholeLine: true,
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
			this.removed,
			this.modified,
			this.reviewBar,
			this.hunkActions,
		);

		// Register the CodeLens provider for the whole-file bar and per-hunk
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
				editor.setDecorations(this.removed, []);
				editor.setDecorations(this.modified, []);
				editor.setDecorations(this.reviewBar, []);
				editor.setDecorations(this.hunkActions, []);
				this.decoratedEditors.delete(editor);
			}
		}

		for (const editor of vscode.window.visibleTextEditors) {
			const proposal = this.proposalsByUri.get(editor.document.uri.toString());
			if (!proposal || proposal.status !== "pending") continue;
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
		const removed: vscode.DecorationOptions[] = [];
		const modified: vscode.DecorationOptions[] = [];
		const bar: vscode.DecorationOptions[] = [];
		const actions: vscode.DecorationOptions[] = [];
		const lineCount = editor.document.lineCount;

		const pendingHunks = proposal.hunks.filter(
			(h) => h.status === "pending" && (h.oldText.length > 0 || h.newText.length > 0),
		);
		if (pendingHunks.length === 0) {
			editor.setDecorations(this.added, []);
			editor.setDecorations(this.removed, []);
			editor.setDecorations(this.modified, []);
			editor.setDecorations(this.reviewBar, []);
			editor.setDecorations(this.hunkActions, []);
			return;
		}

		// ── Whole-file question at the top of the file ──────────────
		const { added: addedLines, removed: removedLines } =
			countHunkLines(pendingHunks);
		const barMd = new vscode.MarkdownString(undefined, true);
		barMd.isTrusted = true;
		barMd.appendMarkdown(
			`**CodePi: ${pendingHunks.length} change${pendingHunks.length === 1 ? "" : "s"} pending in ${proposal.path}**  \n`,
		);
		link(barMd, "$(check-all) Accept All", "codepi.acceptFile", [proposal.proposalId]);
		link(barMd, "$(discard) Reject All", "codepi.rejectFile", [proposal.proposalId]);
		link(barMd, "$(diff) Open Diff", "codepi.openDiff", [proposal.proposalId]);
		bar.push({
			range: new vscode.Range(0, 0, 0, 0),
			hoverMessage: barMd,
			renderOptions: {
				before: {
					contentText: `📝 ${pendingHunks.length} change${pendingHunks.length === 1 ? "" : "s"} · +${addedLines} −${removedLines} —  Accept All   Reject All   Open Diff`,
					color: new vscode.ThemeColor("button.foreground"),
					backgroundColor: new vscode.ThemeColor("editorWidget.background"),
					border: "1px solid var(--vscode-widget-border, #454545)",
					margin: "0 8px 0 0",
					fontWeight: "600",
				},
			},
		});

		for (const [idx, hunk] of pendingHunks.entries()) {
			if (hunk.oldText.length === 0) {
				// Pure insertion — green lines.
				for (let ln = hunk.modifiedStartLine; ln <= hunk.modifiedEndLine; ln++) {
					if (ln > 0 && ln <= lineCount) {
						added.push({ range: new vscode.Range(ln - 1, 0, ln, 0) });
					}
				}
			} else if (hunk.newText.length === 0) {
				// Pure deletion — red decoration on the anchor line + preview.
				const anchor = Math.min(hunk.modifiedStartLine, lineCount);
				const previewLines = splitLines(hunk.oldText);
				const preview = escapeHtml(
					previewLines.slice(0, 4).join("\n") +
						(previewLines.length > 4 ? "\n…" : ""),
				);
				removed.push({
					range: new vscode.Range(anchor - 1, 0, anchor, 0),
					renderOptions: {
						before: {
							contentText: preview,
							color: new vscode.ThemeColor("diffEditor.removedTextForeground"),
							backgroundColor: new vscode.ThemeColor(
								"diffEditor.removedTextBackground",
							),
							border: "1px solid var(--vscode-diffEditor-removedTextBackground)",
							margin: "0 12px 2px 0",
							textDecoration: "line-through",
						},
					},
				});
			} else {
				// Modification — amber whole-line highlight.
				for (let ln = hunk.modifiedStartLine; ln <= hunk.modifiedEndLine; ln++) {
					if (ln > 0 && ln <= lineCount) modified.push({ range: new vscode.Range(ln - 1, 0, ln, 0) });
				}
			}

			// ── Snippet-by-snippet question: action pill at the end of
			//    the hunk's last line + clickable buttons on hover. ──
			const lastLine = Math.min(
				Math.max(hunk.modifiedEndLine, hunk.modifiedStartLine) - 1,
				lineCount - 1,
			);
			if (lastLine >= 0) {
				const hunkMd = new vscode.MarkdownString(undefined, true);
				hunkMd.isTrusted = true;
				hunkMd.appendMarkdown(
					`**Change ${idx + 1} of ${pendingHunks.length}** — accept or reject this snippet?  \n`,
				);
				link(hunkMd, "$(check) Accept", "codepi.acceptHunk", [
					proposal.proposalId,
					hunk.hunkId,
				]);
				link(hunkMd, "$(close) Reject", "codepi.rejectHunk", [
					proposal.proposalId,
					hunk.hunkId,
				]);
				actions.push({
					range: new vscode.Range(lastLine, 0, lastLine, 0),
					hoverMessage: hunkMd,
					renderOptions: {
						after: {
							contentText: "  ✓ Accept    ✕ Reject  ",
							color: new vscode.ThemeColor("button.foreground"),
							backgroundColor: new vscode.ThemeColor(
								"button.background",
							),
							border: "1px solid var(--vscode-button-border, transparent)",

							margin: "0 0 0 12px",
							fontWeight: "600",
						},
					},
				});
			}
		}

		editor.setDecorations(this.added, added);
		editor.setDecorations(this.removed, removed);
		editor.setDecorations(this.modified, modified);
		editor.setDecorations(this.reviewBar, bar);
		editor.setDecorations(this.hunkActions, actions);
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
			editor.setDecorations(this.removed, []);
			editor.setDecorations(this.modified, []);
			editor.setDecorations(this.reviewBar, []);
			editor.setDecorations(this.hunkActions, []);
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

	const provider = new class implements vscode.TextDocumentContentProvider {
		async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
			const isOriginal = uri.scheme === "codepi-diff-original";
			if (isOriginal) return proposal.originalContent;
			return proposal.proposedContent;
		}
	}();

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
	setTimeout(() => {
		reg.dispose();
		reg2.dispose();
	}, 5 * 60 * 1000);
}

// Exported for tests/type safety.
export type { EditHunk };
