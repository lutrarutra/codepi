import { useCallback, useState } from "react";
import type { ToolCallState } from "../types";

interface Props {
	toolCall: ToolCallState;
	onAcceptFile: (proposalId: string) => void;
	onRejectFile: (proposalId: string) => void;
	onOpenDiff: (proposalId: string) => void;
}

/**
 * Compact per-file edit card shown inside a tool call result. Mirrors the
 * Copilot "Edited file — N changes pending review" card with Accept/Decline.
 */
export function EditCard({ toolCall, onAcceptFile, onRejectFile, onOpenDiff }: Props) {
	const [expanded, setExpanded] = useState(false);
	const ep = toolCall.editProposal;
	if (!ep) return null;

	const resolved = ep.status !== "pending";

	const handleAccept = useCallback(
		() => onAcceptFile(ep.proposalId),
		[ep.proposalId, onAcceptFile],
	);
	const handleReject = useCallback(
		() => onRejectFile(ep.proposalId),
		[ep.proposalId, onRejectFile],
	);
	const handleDiff = useCallback(
		() => onOpenDiff(ep.proposalId),
		[ep.proposalId, onOpenDiff],
	);

	return (
		<div className={`edit-card status-${ep.status}`}>
			<button
				className="edit-card-header"
				onClick={() => setExpanded((v) => !v)}
				title="Toggle details"
			>
				<span className="edit-card-icon">
					{resolved ? "✓" : "📝"}
				</span>
				<span className="edit-card-text">
					Edited {ep.path} — {ep.hunkCount} change
					{ep.hunkCount === 1 ? "" : "s"}{" "}
					{resolved ? "reviewed" : "pending review"}
				</span>
				<span className={`edit-card-chevron ${expanded ? "open" : ""}`}>
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
			</button>
			{!resolved && (
				<div className="edit-card-actions">
					<button className="edit-review-btn accept" onClick={handleAccept}>
						Accept
					</button>
					<button className="edit-review-btn reject" onClick={handleReject}>
						Decline
					</button>
					<button className="edit-review-btn ghost" onClick={handleDiff}>
						Open Diff
					</button>
				</div>
			)}
			{expanded && (
				<div className="edit-card-detail">
					Review the changes inline in the editor (green = added, red =
					removed). Each change has its own Accept/Reject action via the
					CodeLens above the affected lines.
				</div>
			)}
		</div>
	);
}
