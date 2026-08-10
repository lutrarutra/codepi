/**
 * Editor integration for edit review.
 *
 * Files with pending review proposals get two visual surfaces:
 *  - Whole-line highlights on the changed lines, rendered with
 *    TextEditorDecorationType + editor.setDecorations:
 *      green  = lines present in the current document that differ from the
 *               original (pure insertions and modifications)
 *      red    = the anchor line right after a pure deletion (the deleted
 *               lines no longer exist, so the line that follows the removed
 *               block is marked instead — matching the diff editor's inline
 *               rendering)
 *    Only hunks still awaiting review ("pending") are highlighted; hunks the
 *    user accepted or rejected drop out of the highlight.
 *  - File-level CodeLens actions (Accept All / Reject All) at the top of the
 *    file.
 *
 * Highlight ranges are recomputed from the proposal's ORIGINAL content
 * against the live document text on every refresh, so they stay accurate
 * even after partial accepts/rejects shift line numbers or after the user
 * edits the file (unmatched hunks are simply not highlighted).
 */

import * as vscode from "vscode";
import { computeHunks } from "./diff";
import type { EditHunk, EditProposal } from "./types";

export interface ReviewActionHandlers {
	acceptHunk(proposalId: string, hunkId: string): Promise<void>;
	rejectHunk(proposalId: string, hunkId: string): Promise<void>;
	acceptFile(proposalId: string): Promise<void>;
	rejectFile(proposalId: string): Promise<void>;
	openDiff(proposalId: string): Promise<void>;
}

/**
 * Cap for recomputing highlight ranges. Recomputing diffs against the live
 * document is O(ND) (Myers); on huge files this guard skips highlighting
 * entirely rather than blocking the extension host.
 */
export const MAX_HIGHLIGHT_LINES = 20_000;

export class ReviewDecorations {
	private readonly proposalsByUri = new Map<string, EditProposal>();
	private codeLens: vscode.Disposable | undefined;
	private refreshTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly disposables: vscode.Disposable[] = [];

	/** Green whole-line highlight for lines added/changed by the agent. */
	private readonly addedDecoration = vscode.window.createTextEditorDecorationType(
		{
			isWholeLine: true,
			backgroundColor: new vscode.ThemeColor(
				"diffEditor.insertedLineBackground",
			),
			overviewRulerColor: new vscode.ThemeColor(
				"diffEditor.insertedLineBackground",
			),
			overviewRulerLane: vscode.OverviewRulerLane.Left,
		},
	);

	/** Red whole-line highlight marking the line right after a deletion. */
	private readonly removedDecoration = vscode.window.createTextEditorDecorationType(
		{
			isWholeLine: true,
			backgroundColor: new vscode.ThemeColor(
				"diffEditor.removedLineBackground",
			),
			overviewRulerColor: new vscode.ThemeColor(
				"diffEditor.removedLineBackground",
			),
			overviewRulerLane: vscode.OverviewRulerLane.Left,
		},
	);

	constructor() {
		// Keep the provider in the editor so each pending file has one stable,
		// file-level accept/reject surface. Changed-line highlights are driven
		// by the same refresh cycle.
		this.disposables.push(
			vscode.window.onDidChangeActiveTextEditor(() => this.refresh()),
			vscode.window.onDidChangeVisibleTextEditors(() => this.refresh()),
			vscode.workspace.onDidCloseTextDocument((doc) => {
				if (this.proposalsByUri.has(doc.uri.toString())) this.refresh();
			}),
			vscode.workspace.onDidChangeTextDocument((event) => {
				if (this.proposalsByUri.has(event.document.uri.toString())) {
					this.refresh();
				}
			}),
		);
		this.registerCodeLens();
	}

	/**
	 * Provide only file-level review actions. Line highlights are rendered as
	 * decorations (see applyDecorations); per-hunk CodeLens actions are not
	 * provided.
	 */
	private provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
		const proposal = this.proposalsByUri.get(document.uri.toString());
		if (!proposal || proposal.status !== "pending") return [];

		const pendingHunks = proposal.hunks.filter((h) => h.status === "pending");
		if (pendingHunks.length === 0) return [];

		const top = new vscode.Range(0, 0, 0, 0);
		return [
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
		];
	}

	/** Dispose the previous registration and re-register to force a re-query. */
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

	/** Re-paint changed-line highlights in every visible editor. */
	private applyDecorations(): void {
		for (const editor of vscode.window.visibleTextEditors) {
			const doc = editor.document;
			const proposal = this.proposalsByUri.get(doc.uri.toString());
			if (
				!proposal ||
				proposal.status !== "pending" ||
				!proposal.hunks.some((h) => h.status === "pending")
			) {
				editor.setDecorations(this.addedDecoration, []);
				editor.setDecorations(this.removedDecoration, []);
				continue;
			}

			const { added, removed } = computeDecorationRanges(
				proposal.originalContent,
				doc.getText(),
				proposal.hunks,
				doc.lineCount,
			);
			editor.setDecorations(this.addedDecoration, this.withHover(added, true));
			editor.setDecorations(this.removedDecoration, this.withHover(removed, false));
		}
	}

	/** Attach an explanatory hover to each highlighted line. */
	private withHover(
		ranges: vscode.Range[],
		added: boolean,
	): vscode.DecorationOptions[] {
		const hoverMessage = added
			? "Pending edit review — accept or reject from the file header."
			: "Pending edit review — lines were removed here.";
		return ranges.map((range) => ({ range, hoverMessage }));
	}

	/** Debounce CodeLens re-registration and highlight updates across bursts. */
	private scheduleRefresh(): void {
		if (this.refreshTimer !== undefined) clearTimeout(this.refreshTimer);
		this.refreshTimer = setTimeout(() => {
			this.refreshTimer = undefined;
			this.registerCodeLens();
			this.applyDecorations();
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

	/** Refresh the CodeLens provider and line highlights. */
	refresh(): void {
		this.scheduleRefresh();
	}

	dispose(): void {
		if (this.refreshTimer !== undefined) clearTimeout(this.refreshTimer);
		this.refreshTimer = undefined;
		try {
			this.codeLens?.dispose();
		} catch {
			/* ignore */
		}
		this.codeLens = undefined;
		for (const decoration of [this.addedDecoration, this.removedDecoration]) {
			try {
				decoration.dispose();
			} catch {
				/* ignore */
			}
		}
		for (const disposable of this.disposables) {
			try {
				disposable.dispose();
			} catch {
				/* ignore */
			}
		}
		this.disposables.length = 0;
	}
}

/**
 * Compute whole-line highlight ranges for a reviewed file.
 *
 * Hunks are recomputed between the proposal's ORIGINAL content and the live
 * document text, then matched back to the proposal's hunks by exact
 * old/new text so that only hunks still awaiting review ("pending") are
 * highlighted. This keeps highlights accurate when earlier accepts/rejects
 * shifted line numbers (the stored modifiedStartLine/modifiedEndLine would
 * be stale) and ignores the user's own edits (which produce hunks that do
 * not match any pending proposal hunk).
 *
 * Returns 1-based line ranges:
 *  - `added`: lines present in the current document that differ from the
 *    original (pure insertions and modifications) — highlighted green
 *  - `removed`: the anchor line right after a pure deletion — highlighted
 *    red; empty when the deletion sits at EOF without a line to paint
 */
export function computeDecorationRanges(
	originalContent: string,
	currentContent: string,
	hunks: EditHunk[],
	lineCount: number,
): { added: vscode.Range[]; removed: vscode.Range[] } {
	if (!hunks.some((h) => h.status === "pending")) {
		return { added: [], removed: [] };
	}
	if (lineCount > MAX_HIGHLIGHT_LINES) {
		return { added: [], removed: [] };
	}

	// Status per hunk text, with precedence pending > stale > settled, so an
	// identical change repeated at two locations is highlighted while any
	// copy of it is still pending.
	const statusByText = new Map<string, EditHunk["status"]>();
	for (const h of hunks) {
		const key = h.oldText + "\u0000" + h.newText;
		const prev = statusByText.get(key);
		if (prev === "pending") continue;
		if (h.status === "pending") {
			statusByText.set(key, "pending");
		} else if (prev !== "stale" && h.status === "stale") {
			statusByText.set(key, "stale");
		} else if (prev === undefined) {
			statusByText.set(key, h.status);
		}
	}

	const added: vscode.Range[] = [];
	const removed: vscode.Range[] = [];
	for (const hunk of computeHunks(originalContent, currentContent)) {
		if (statusByText.get(hunk.oldText + "\u0000" + hunk.newText) !== "pending") {
			continue;
		}
		if (hunk.modifiedEndLine > 0) {
			added.push(
				new vscode.Range(
					hunk.modifiedStartLine - 1,
					0,
					hunk.modifiedEndLine - 1,
					0,
				),
			);
		} else {
			// Pure deletion: paint the line that follows the removed block.
			const anchor = hunk.modifiedStartLine;
			if (anchor >= 1 && anchor <= lineCount) {
				removed.push(new vscode.Range(anchor - 1, 0, anchor - 1, 0));
			}
		}
	}
	return { added, removed };
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
