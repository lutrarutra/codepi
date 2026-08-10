/** Message and data types for the Sessions sidebar tab (host ↔ webview). */

/** A single pi session listed in the sidebar. */
export interface SessionEntry {
	id: string;
	path: string;
	name?: string;
	firstMessage: string;
	messageCount: number;
	/** Epoch ms of the last modification. */
	modified: number;
	/** Host-formatted compact date label (e.g. "2h", "Yesterday", "Mon"). */
	dateLabel: string;
	/** Whether the user pinned this session to the top of the sidebar list. */
	pinned: boolean;
}

export type SessionsMessage =
	| { type: "get" }
	| { type: "refresh" }
	| { type: "new" }
	| { type: "open"; path: string }
	| { type: "rename"; path: string }
	| { type: "delete"; path: string }
	| { type: "pin"; path: string; pinned: boolean }
	| { type: "openExtensions" }
	| { type: "openSettings" };

export type SessionsReply =
	| { type: "list"; sessions: SessionEntry[]; hasWorkspace: boolean }
	| { type: "error"; message: string };
