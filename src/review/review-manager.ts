/**
 * ReviewManager — owns pending edit proposals and hunk resolution.
 *
 * VS Code Copilot semantics implemented here:
 *  - The agent's edit is applied to the real document and SAVED immediately.
 *  - The original snapshot + line hunks are tracked as "pending".
 *  - Accept keeps the applied change; Reject applies the inverse of that hunk
 *    to the current document and saves.
 *  - If the document no longer matches the proposal (user/external edits),
 *    the proposal is marked stale and nothing is auto-applied on top.
 */

import { contentHash, computeHunks, countHunkLines } from "./diff";
import type {
	EditHunk,
	EditProposal,
	EditProposalSummary,
	FileReviewState,
	ProposalCounts,
	ReviewHost,
} from "./types";
export interface CreateProposalInput {
	toolCallId: string;
	uri: string;
	path: string;
	originalContent: string;
	proposedContent: string;
}

export class ReviewManager {
	private readonly proposals = new Map<string, EditProposal>();

	constructor(
		private readonly host: ReviewHost,
		private readonly io: {
			readContent: (uri: string) => Promise<string>;
			writeContent: (uri: string, content: string) => Promise<void>;
		},
	) {}

	// ── queries ────────────────────────────────────────────────────────────

	getProposal(proposalId: string): EditProposal | undefined {
		return this.proposals.get(proposalId);
	}

	getProposalByFile(uri: string): EditProposal | undefined {
		for (const p of this.proposals.values()) {
			if (p.uri === uri && p.status === "pending") return p;
		}
		return undefined;
	}

	allProposals(): EditProposal[] {
		return [...this.proposals.values()];
	}

	counts(proposal: EditProposal): ProposalCounts {
		return computeCounts(proposal);
	}

	summary(proposal: EditProposal): EditProposalSummary {
		return {
			proposalId: proposal.proposalId,
			toolCallId: proposal.toolCallId,
			path: proposal.path,
			status: proposal.status,
			counts: this.counts(proposal),
		};
	}

	// ── proposal creation ─────────────────────────────────────────────────

	/**
	 * Register a proposal. The agent tool must have ALREADY applied and saved
	 * `proposedContent` to disk — this matches VS Code, which persists the edit
	 * before review. Returns the created proposal (or the existing pending
	 * proposal for the same file, re-based onto the new content).
	 */
	createProposal(input: CreateProposalInput): EditProposal {
		const existing = this.getProposalByFile(input.uri);
		if (existing) {
			// Re-base: the previous proposal's proposed content becomes the new
			// original for the same agent run.
			this.proposals.delete(existing.proposalId);
			input.originalContent = existing.proposedContent;
		}

		const hunks = computeHunks(input.originalContent, input.proposedContent);
		const proposal: EditProposal = {
			proposalId: `prop-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
			toolCallId: input.toolCallId,
			uri: input.uri,
			path: input.path,
			originalContent: input.originalContent,
			proposedContent: input.proposedContent,
			proposedHash: contentHash(input.proposedContent),
			hunks,
			createdAt: Date.now(),
			status: "pending",
		};
		this.proposals.set(proposal.proposalId, proposal);
		this.host.post({
			command: "editProposed",
			summary: this.summary(proposal),
		});
		return proposal;
	}

	// ── hunk resolution ───────────────────────────────────────────────────

	/** Accept a single hunk (change stays applied). */
	async acceptHunk(proposalId: string, hunkId: string): Promise<boolean> {
		return this.resolveHunk(proposalId, hunkId, "accepted");
	}

	/** Reject a single hunk — apply its inverse and save. */
	async rejectHunk(proposalId: string, hunkId: string): Promise<boolean> {
		return this.resolveHunk(proposalId, hunkId, "rejected");
	}

	/** Accept all pending hunks in a file. */
	async acceptFile(proposalId: string): Promise<boolean> {
		const proposal = this.proposals.get(proposalId);
		if (!proposal || proposal.status !== "pending") return false;
		let changed = false;
		for (const h of proposal.hunks) {
			if (h.status === "pending") {
				h.status = "accepted";
				changed = true;
			}
		}
		if (!changed) return false;
		proposal.status = this.deriveStatus(proposal);
		this.emitUpdate(proposal);
		return true;
	}

	/** Reject all pending hunks in a file — reverts the whole file. */
	async rejectFile(proposalId: string): Promise<boolean> {
		const proposal = this.proposals.get(proposalId);
		if (!proposal || proposal.status !== "pending") return false;
		const stale = await this.checkStale(proposal);
		if (stale) return false;
		// Revert the whole file to the original content.
		await this.io.writeContent(proposal.uri, proposal.originalContent);
		for (const h of proposal.hunks) h.status = "rejected";
		proposal.status = "rejected";
		this.emitUpdate(proposal);
		return true;
	}

	/**
	 * Resolve every pending hunk WITHOUT touching the file on disk. Used when
	 * an external source (e.g. the TUI's /filechanges commands) has already
	 * applied the outcome — we only mirror the review state so editor
	 * decorations and the review bar clear.
	 */
	async resolveFile(
		proposalId: string,
		status: "accepted" | "rejected",
	): Promise<boolean> {
		const proposal = this.proposals.get(proposalId);
		if (!proposal) return false;
		let changed = false;
		for (const h of proposal.hunks) {
			if (h.status === "pending") {
				h.status = status;
				changed = true;
			}
		}
		if (!changed) return false;
		proposal.status = this.deriveStatus(proposal);
		this.emitUpdate(proposal);
		return true;
	}

	/** Accept every pending proposal. */
	async acceptAll(): Promise<number> {
		let n = 0;
		for (const p of this.allPending()) {
			if (await this.acceptFile(p.proposalId)) n++;
		}
		return n;
	}

	/** Reject every pending proposal. */
	async rejectAll(): Promise<number> {
		let n = 0;
		for (const p of this.allPending()) {
			if (await this.rejectFile(p.proposalId)) n++;
		}
		return n;
	}

	// ── internals ─────────────────────────────────────────────────────────

	private allPending(): EditProposal[] {
		return [...this.proposals.values()].filter((p) => p.status === "pending");
	}

	private deriveStatus(proposal: EditProposal): EditProposal["status"] {
		if (proposal.hunks.length === 0) return "accepted";
		let accepted = true;
		let rejected = true;
		for (const h of proposal.hunks) {
			if (h.status === "pending" || h.status === "stale") return "pending";
			if (h.status !== "accepted") accepted = false;
			if (h.status !== "rejected") rejected = false;
		}
		return accepted ? "accepted" : rejected ? "rejected" : "pending";
	}

	private async resolveHunk(
		proposalId: string,
		hunkId: string,
		status: "accepted" | "rejected",
	): Promise<boolean> {
		const proposal = this.proposals.get(proposalId);
		if (!proposal || proposal.status !== "pending") return false;
		const hunk = proposal.hunks.find((h) => h.hunkId === hunkId);
		if (!hunk || hunk.status !== "pending") return false;

		const stale = await this.checkStale(proposal);
		if (stale) return false;

		if (status === "rejected") {
			// Apply the inverse of THIS hunk to the current document and save.
			const current = await this.io.readContent(proposal.uri);
			const inverse = computeInverseEdit(
				current,
				hunk,
				proposal.originalContent,
			);
			if (inverse === undefined) {
				this.markStale(proposal);
				return false;
			}
			const next =
				current.slice(0, inverse.start) +
				inverse.replacement +
				current.slice(inverse.end);
			await this.io.writeContent(proposal.uri, next);
		}

		hunk.status = status;
		proposal.status = this.deriveStatus(proposal);

		if (status === "rejected") {
			// The file changed because of OUR inverse edit — track the new
			// expected content so later staleness checks compare correctly.
			proposal.proposedContent = await this.io.readContent(proposal.uri);
			proposal.proposedHash = contentHash(proposal.proposedContent);
		}

		this.emitUpdate(proposal);
		return true;
	}

	/** Compare the current on-disk content against the proposal baseline. */
	private async checkStale(proposal: EditProposal): Promise<boolean> {
		if (proposal.status !== "pending") return true;
		try {
			const current = await this.io.readContent(proposal.uri);
			if (contentHash(current) !== proposal.proposedHash) {
				// The user (or something else) edited the file after the agent.
				// We must not apply inverse edits on top of their changes.
				this.markStale(proposal);
				return true;
			}
			return false;
		} catch {
			this.markStale(proposal);
			return true;
		}
	}

	private markStale(proposal: EditProposal): void {
		proposal.status = "stale";
		for (const h of proposal.hunks) {
			if (h.status === "pending") h.status = "stale";
		}
		this.emitUpdate(proposal);
	}

	private emitUpdate(proposal: EditProposal): void {
		this.host.post({ command: "editUpdated", summary: this.summary(proposal) });
	}
}

// ── pure inverse-edit helpers (exported for tests) ─────────────────────

/** Character offset where 1-based `line` starts in `content`. */
export function lineStartOffset(content: string, line: number): number {
	if (line <= 1) return 0;
	let pos = 0;
	for (let i = 1; i < line; i++) {
		const idx = content.indexOf("\n", pos);
		if (idx === -1) return content.length;
		pos = idx + 1;
	}
	return pos;
}

export interface InverseEdit {
	start: number;
	end: number;
	replacement: string;
}

/**
 * Compute the inverse edit that reverts `hunk` inside `current` content.
 *
 * Hunks are line-based: the modified block occupies
 * `[lineStartOffset(modifiedStartLine), lineStartOffset(modifiedEndLine + 1))`
 * in the current content, i.e. `newText` + the trailing line terminator (if
 * the block isn't at EOF-without-newline). Hunk texts are derived from the raw
 * content (lines keep their `\r` in CRLF files), so a `startsWith` check at
 * the block's first modified line is both CRLF-safe and unambiguous — it
 * cannot match a duplicated snippet elsewhere in the file (unlike `indexOf`).
 *
 * Returns:
 *  - modification: replace the whole modified block with `oldText` + the
 *    terminator the ORIGINAL block ended with (from `originalContent`)
 *  - pure insertion: delete the inserted block entirely (replacement "")
 *  - pure deletion: insert `oldText` (with correct newline handling) before
 *    the anchor line, restoring the removed lines in place
 *  - `undefined` when the hunk's modified text no longer matches the current
 *    content at the expected location (stale).
 */
export function computeInverseEdit(
	current: string,
	hunk: EditHunk,
	originalContent?: string,
): InverseEdit | undefined {
	const anchor = lineStartOffset(current, hunk.modifiedStartLine);

	if (hunk.newText.length === 0) {
		// Pure deletion: the removed lines were anchored just before the line
		// that now sits at `modifiedStartLine`. Re-insert them there.
		if (hunk.oldText.length === 0) {
			// Degenerate empty hunk — nothing to restore.
			return { start: anchor, end: anchor, replacement: "" };
		}
		// If the anchor is not preceded by a newline, the deletion happened at
		// the end of a file without a trailing newline — put the removed lines
		// on their own line first.
		const needsLeadingNl = anchor > 0 && current[anchor - 1] !== "\n";
		const inserted = needsLeadingNl ? "\n" + hunk.oldText : hunk.oldText + "\n";
		return { start: anchor, end: anchor, replacement: inserted };
	}

	// Modification or insertion: verify newText is exactly at the block start.
	const end = lineStartOffset(current, hunk.modifiedEndLine + 1);
	const slice = current.slice(anchor, end);
	if (!slice.startsWith(hunk.newText)) return undefined;

	// Replacement text: oldText + the terminator the ORIGINAL block ended
	// with. Pure insertions (oldText empty) are reverted by deleting the
	// inserted block entirely.
	let replacement: string;
	if (hunk.oldText.length === 0) {
		replacement = "";
	} else {
		let trailingOld = "\n";
		if (originalContent) {
			const oStart = lineStartOffset(originalContent, hunk.originalStartLine);
			const oEnd = lineStartOffset(originalContent, hunk.originalEndLine + 1);
			const origSlice = originalContent.slice(oStart, oEnd);
			if (origSlice.startsWith(hunk.oldText)) {
				trailingOld = origSlice.slice(hunk.oldText.length);
			}
		}
		replacement = hunk.oldText + trailingOld;
	}

	return { start: anchor, end, replacement };
}

/** Count hunks/lines for a proposal without a manager instance. */
export function computeCounts(proposal: EditProposal): ProposalCounts {
	let pending = 0;
	let accepted = 0;
	let rejected = 0;
	for (const h of proposal.hunks) {
		if (h.status === "pending") pending++;
		else if (h.status === "accepted") accepted++;
		else if (h.status === "rejected") rejected++;
	}
	const { added, removed } = countHunkLines(proposal.hunks);
	return {
		total: proposal.hunks.length,
		pending,
		accepted,
		rejected,
		linesAdded: added,
		linesRemoved: removed,
	};
}

/** Count added/removed lines across ONLY the pending hunks. */
export function pendingLineCounts(proposal: EditProposal): {
	pendingHunks: number;
	added: number;
	removed: number;
} {
	let pendingHunks = 0;
	let added = 0;
	let removed = 0;
	for (const h of proposal.hunks) {
		if (h.status !== "pending") continue;
		pendingHunks++;
		if (h.oldText.length > 0) removed += h.oldText.split("\n").length;
		if (h.newText.length > 0) added += h.newText.split("\n").length;
	}
	return { pendingHunks, added, removed };
}

/** Convenience: compute the FileReviewState for the webview mirror. */
export function toFileReviewState(proposal: EditProposal): FileReviewState {
	return {
		proposal,
		counts: computeCounts(proposal),
		allResolved:
			proposal.status === "accepted" || proposal.status === "rejected",
	};
}
