/**
 * Editor integration for edit review.
 *
 * The editor intentionally does not render per-hunk inline diff snippets.
 * Those overlays are fragile when successive writes change line positions and
 * can obscure the real document. Review stays available through file-level
 * CodeLens actions and the side-by-side diff view.
 */

import * as vscode from "vscode";
import type { EditProposal } from "./types";

export interface ReviewActionHandlers {
	acceptHunk(proposalId: string, hunkId: string): Promise<void>;
	rejectHunk(proposalId: string, hunkId: string): Promise<void>;
	acceptFile(proposalId: string): Promise<void>;
	rejectFile(proposalId: string): Promise<void>;
	openDiff(proposalId: string): Promise<void>;
}

export class ReviewDecorations {
	private readonly proposalsByUri = new Map<string, EditProposal>();
	private codeLens: vscode.Disposable | undefined;
	private codeLensTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly disposables: vscode.Disposable[] = [];

	constructor() {
		// Keep the provider in the editor so each pending file has one stable,
		// file-level accept/reject surface. No TextEditorDecorationType is
		// created: per-hunk green/red snippet decorations are intentionally off.
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
	 * Provide only file-level review actions. Hunk locations are deliberately
	 * not exposed because snippet-level decorations and actions are disabled.
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

	/** Debounce provider re-registration across bursts of review changes. */
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

	/** Refresh the file-level CodeLens provider. */
	refresh(): void {
		this.scheduleCodeLensRefresh();
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
