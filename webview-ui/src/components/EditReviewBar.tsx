import { useCallback, useMemo, useState } from "react";
import type { EditProposalSummary, ProposalStatus } from "../types";

interface Props {
	proposals: Record<string, EditProposalSummary>;
	onAcceptFile: (proposalId: string) => void;
	onRejectFile: (proposalId: string) => void;
	onAcceptAll: () => void;
	onRejectAll: () => void;
	onOpenDiff: (proposalId: string) => void;
}

const STATUS_LABEL: Record<ProposalStatus, string> = {
	pending: "Pending",
	accepted: "Accepted",
	rejected: "Declined",
	stale: "Stale",
};

export function EditReviewBar({
	proposals,
	onAcceptFile,
	onRejectFile,
	onAcceptAll,
	onRejectAll,
	onOpenDiff,
}: Props) {
	const list = useMemo(() => Object.values(proposals), [proposals]);
	const [expanded, setExpanded] = useState(true);

	const pending = useMemo(
		() =>
			list.filter(
				(p) => p.status === "pending" && p.counts.pending > 0,
			),
		[list],
	);

	const handleAcceptAll = useCallback(() => onAcceptAll(), [onAcceptAll]);
	const handleRejectAll = useCallback(() => onRejectAll(), [onRejectAll]);

	// Nothing awaiting review (0 files with pending edits) — hide the whole
	// bar, including any "all reviewed" empty state.
	if (pending.length === 0) return null;

	return (
		<div className={`edit-review-bar ${expanded ? "expanded" : "collapsed"}`}>
			<div className="edit-review-bar-header">
				<button
					className="edit-review-toggle"
					onClick={() => setExpanded((v) => !v)}
					title={expanded ? "Collapse" : "Expand"}
				>
					<span
						className={`edit-review-chevron ${expanded ? "open" : ""}`}
					>
						<svg
							width="10"
							height="10"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<polyline points="9 18 15 12 9 6" />
						</svg>
					</span>
					<span className="edit-review-title">
						📝 {pending.length} file{pending.length === 1 ? "" : "s"} with
						edits pending review
					</span>
				</button>
				{pending.length > 0 && (
					<div className="edit-review-actions">
						<button
							className="edit-review-btn accept-all"
							onClick={handleAcceptAll}
						>
							Accept All
						</button>
						<button
							className="edit-review-btn reject-all"
							onClick={handleRejectAll}
						>
							Reject All
						</button>
					</div>
				)}
			</div>

			{expanded && pending.length > 0 && (
				<div className="edit-review-files">
					{pending.map((p) => (
						<EditFileRow
							key={p.proposalId}
							summary={p}
							onAcceptFile={onAcceptFile}
							onRejectFile={onRejectFile}
							onOpenDiff={onOpenDiff}
						/>
					))}
				</div>
			)}
		</div>
	);
}

function EditFileRow({
	summary,
	onAcceptFile,
	onRejectFile,
	onOpenDiff,
}: {
	summary: EditProposalSummary;
	onAcceptFile: (proposalId: string) => void;
	onRejectFile: (proposalId: string) => void;
	onOpenDiff: (proposalId: string) => void;
}) {
	const c = summary.counts;
	const [showDetail, setShowDetail] = useState(false);
	return (
		<div className={`edit-file-row status-${summary.status}`}>
			<button
				className="edit-file-name"
				onClick={() => setShowDetail((v) => !v)}
				title="Toggle details"
			>
				<span className="edit-file-path">{summary.path}</span>
				<span className="edit-file-stats">
					{c.total} change{c.total === 1 ? "" : "s"}
					{c.linesAdded > 0 && (
						<span className="stat-added">+{c.linesAdded}</span>
					)}
					{c.linesRemoved > 0 && (
						<span className="stat-removed">-{c.linesRemoved}</span>
					)}
				</span>
			</button>
			<div className="edit-file-actions">
				<button
					className="edit-review-btn accept"
					onClick={() => onAcceptFile(summary.proposalId)}
					title={`Accept all ${c.total} changes in this file`}
				>
					Accept
				</button>
				<button
					className="edit-review-btn reject"
					onClick={() => onRejectFile(summary.proposalId)}
					title={`Revert all ${c.total} changes in this file`}
				>
					Reject
				</button>
				<button
					className="edit-review-btn ghost"
					onClick={() => onOpenDiff(summary.proposalId)}
					title="Open side-by-side diff"
				>
					Diff
				</button>
			</div>
			{showDetail && (
				<div className="edit-file-detail">
					<div className="edit-file-detail-row">
						<span>
							Status:{" "}
							<strong className={`status-${summary.status}`}>
								{STATUS_LABEL[summary.status]}
							</strong>
						</span>
						<span>
							{c.pending} pending · {c.accepted} accepted · {c.rejected}{" "}
							rejected
						</span>
					</div>
				</div>
			)}
		</div>
	);
}
