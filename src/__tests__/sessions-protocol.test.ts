import { describe, expect, it } from "vitest";
import type {
	SessionEntry,
	SessionsMessage,
	SessionsReply,
} from "../shared/sessions-protocol";

describe("sessions protocol", () => {
	it("message union covers list, actions, and tab switching", () => {
		const msgs: SessionsMessage[] = [
			{ type: "get" },
			{ type: "refresh" },
			{ type: "new" },
			{ type: "open", path: "/sessions/a" },
			{ type: "rename", path: "/sessions/a" },
			{ type: "delete", path: "/sessions/a" },
			{ type: "openExtensions" },
			{ type: "openSettings" },
		];
		expect(msgs.map((m) => m.type)).toEqual([
			"get",
			"refresh",
			"new",
			"open",
			"rename",
			"delete",
			"openExtensions",
			"openSettings",
		]);
	});

	it("reply union covers the session list and errors", () => {
		const entry: SessionEntry = {
			id: "abc",
			path: "/sessions/abc",
			firstMessage: "hello",
			messageCount: 3,
			modified: 0,
			dateLabel: "Yesterday",
		};
		const replies: SessionsReply[] = [
			{ type: "list", sessions: [entry], hasWorkspace: true },
			{ type: "error", message: "boom" },
		];
		expect(replies[0]).toMatchObject({
			type: "list",
			hasWorkspace: true,
			sessions: [{ id: "abc", messageCount: 3 }],
		});
		expect(replies[1]).toEqual({ type: "error", message: "boom" });
	});
});
