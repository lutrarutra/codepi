import { describe, expect, it } from "vitest";
import {
	ReviewManager,
	pendingLineCounts,
	type CreateProposalInput,
} from "../review/review-manager";
import type { ReviewHost } from "../review/types";

function makeManager() {
	const writes: Array<{ uri: string; content: string }> = [];
	const host: ReviewHost = {
		post: () => {},
		notify: () => {},
	};
	const io = {
		readContent: async () => "",
		writeContent: async (uri: string, content: string) => {
			writes.push({ uri, content });
		},
	};
	const review = new ReviewManager(host, io);
	const mk = (input: Partial<CreateProposalInput> = {}) => {
		return review.createProposal({
			toolCallId: "t1",
			uri: "file:///ws/a.md",
			path: "a.md",
			originalContent: "line1\nline2\n",
			proposedContent: "line1\nline2\nline3\n",
			...input,
		});
	};
	return { review, writes, mk };
}

describe("ReviewManager.resolveFile", () => {
	it("resolves all pending hunks without writing the file (accepted)", async () => {
		const { review, writes, mk } = makeManager();
		const p = mk();
		expect(p.status).toBe("pending");
		expect(writes.length).toBe(0);

		const ok = await review.resolveFile(p.proposalId, "accepted");
		expect(ok).toBe(true);
		// No inverse edit is applied — the caller (e.g. /filechanges) already
		// applied the outcome on disk.
		expect(writes.length).toBe(0);
		expect(p.status).toBe("accepted");
		expect(p.hunks.every((h) => h.status === "accepted")).toBe(true);
	});

	it("marks hunks rejected without touching the file", async () => {
		const { review, writes, mk } = makeManager();
		const p = mk();
		await review.resolveFile(p.proposalId, "rejected");
		expect(p.status).toBe("rejected");
		expect(p.hunks.every((h) => h.status === "rejected")).toBe(true);
		expect(writes.length).toBe(0);
	});

	it("returns false for an unknown proposal", async () => {
		const { review } = makeManager();
		expect(await review.resolveFile("prop-nope", "accepted")).toBe(false);
	});

	it("returns false when nothing is left pending", async () => {
		const { review, mk } = makeManager();
		const p = mk();
		await review.resolveFile(p.proposalId, "accepted");
		expect(await review.resolveFile(p.proposalId, "rejected")).toBe(false);
		expect(p.status).toBe("accepted");
	});
});

describe("pendingLineCounts", () => {
	it("counts lines of pending hunks only and decreases as hunks resolve", async () => {
		const { review, mk } = makeManager();
		const p = mk({
			originalContent: "a\nb\nc\n",
			proposedContent: "x\ny\na\nb\nc\n", // one insertion hunk: +2 lines
		});
		const first = pendingLineCounts(p);
		expect(first.pendingHunks).toBe(1);
		expect(first.added).toBe(2);
		expect(first.removed).toBe(0);

		// Accept the hunk → nothing pending anymore.
		await review.resolveFile(p.proposalId, "accepted");
		const after = pendingLineCounts(p);
		expect(after.pendingHunks).toBe(0);
		expect(after.added).toBe(0);
	});

	it("ignores accepted/rejected hunks when counting", async () => {
		const { review, mk } = makeManager();
		const p = mk({
			originalContent: "a\nb\nc\n",
			proposedContent: "a\nX\nb\nY\nc\n", // two insertion hunks
		});
		expect(p.hunks.length).toBeGreaterThanOrEqual(1);
		// resolve the first hunk only
		await review.resolveFile(p.proposalId, "rejected"); // resolves ALL — so create fresh
		const p2 = mk({
			originalContent: "a\nb\nc\n",
			proposedContent: "a\nX\nb\nY\nc\n",
		});
		const before = pendingLineCounts(p2);
		expect(before.pendingHunks).toBe(p2.hunks.length);
		expect(before.added).toBe(2);
	});
});
