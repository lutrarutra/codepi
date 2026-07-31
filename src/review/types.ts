/**
 * Review domain types for Copilot-style inline edit review.
 *
 * Lifecycle:
 *  1. The agent's write/edit tool computes the proposed content and applies it
 *     to the real document (and saves it to disk) immediately — matching VS Code
 *     Copilot behavior ("applies and saves the edits to disk", then tracks them
 *     as pending edits).
 *  2. A proposal records the ORIGINAL content plus the computed line hunks.
 *  3. The user reviews in the editor (green/red decorations + CodeLens actions)
 *     and via bottom-right per-file notifications / the chat EditCard.
 *  4. Accept → hunk stays applied. Reject → the inverse edit is applied to the
 *     current document and saved, restoring that section to its original text.
 *  5. If the user edits the file independently while a proposal is pending, the
 *     proposal is marked stale and nothing is auto-applied on top.
 */

export type HunkStatus = "pending" | "accepted" | "rejected" | "stale";
export type ProposalStatus = "pending" | "accepted" | "rejected" | "stale";

/** A single contiguous changed region (line-level, 1-based inclusive ranges). */
export interface EditHunk {
	hunkId: string;
	/** Range in the ORIGINAL (pre-edit) content. Empty = pure insertion. */
	originalStartLine: number;
	originalEndLine: number; // inclusive; 0 when empty
	/** Range in the MODIFIED (current, on-disk) content. Empty = pure deletion. */
	modifiedStartLine: number;
	modifiedEndLine: number; // inclusive; 0 when empty
	/** The exact original text of this hunk ('' for insertions). */
	oldText: string;
	/** The exact modified text of this hunk ('' for deletions). */
	newText: string;
	status: HunkStatus;
}

export interface EditProposal {
	proposalId: string;
	/** Tool call that produced this proposal ('' for replay/restored). */
	toolCallId: string;
	uri: string; // vscode.Uri.toString() — survives serialization
	path: string; // display path (workspace-relative when possible)
	/** Content of the file BEFORE the agent edit. */
	originalContent: string;
	/** Content of the file AFTER the agent edit (what is on disk). */
	proposedContent: string;
	/** Full-content hash of `proposedContent` — stale detection. */
	proposedHash: string;
	hunks: EditHunk[];
	createdAt: number;
	status: ProposalStatus;
}

export interface ProposalCounts {
	total: number;
	pending: number;
	accepted: number;
	rejected: number;
	linesAdded: number;
	linesRemoved: number;
}

/** Serializable summary sent to the webview. */
export interface EditProposalSummary {
	proposalId: string;
	toolCallId: string;
	path: string;
	status: ProposalStatus;
	counts: ProposalCounts;
}

export interface FileReviewState {
	proposal: EditProposal;
	counts: ProposalCounts;
	allResolved: boolean;
}

/** Hook the review manager uses to tell the extension host to act. */
export interface ReviewHost {
	/** Post a message to the chat webview(s). */
	post(message: Record<string, unknown>): void;
	/** Show the file in the editor (used when a proposal is created). */
	openFile(uri: string): Promise<void>;
	/** Queue a bottom-right notification asking accept/decline for a file. */
	promptFileReview(summary: EditProposalSummary): void;
	/** Show an informational notification. */
	notify(text: string): void;
}
