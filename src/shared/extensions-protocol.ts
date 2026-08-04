/** Message and data types for the Extensions sidebar tab (host ↔ webview). */

/** Where an extension (or its items) comes from. */
export type SourceTag = "bundled" | "agent" | "project" | "package" | "other";

/** Ask-mode read-only policy for a tool: blocked / read-only-safe / user-whitelisted. */
export type AskMode = "safe" | "whitelisted" | "blocked";

/** Slash-command origin. The probe only ever sees "extension" (skills and
 * prompt templates are enumerated into the core section separately), but the
 * field mirrors the SDK's SlashCommandInfo.source for future live data. */
export type CommandSource = "extension" | "skill" | "prompt";

export interface CommandEntry {
	name: string; // without the leading "/"
	description?: string;
	source: CommandSource;
}

export interface ToolEntry {
	name: string;
	label: string;
	description: string;
	askMode: AskMode;
}

export interface ExtensionEntry {
	displayName: string; // "codepi-bash" | "@juicesharp/rpiv-todo"
	path: string; // resolved path on disk
	source: SourceTag;
	enabled: boolean; // bundled → settings toggle; on-disk → true
	commands: CommandEntry[];
	tools: ToolEntry[];
	events: number;
	flags: number;
	shortcuts: number;
	messageRenderers: number;
}

export interface ModeInfo {
	active: boolean; // a pi session is running in a panel
	current?: "ask" | "plan" | "implement";
	sessionName?: string;
}

export interface ExtensionsSnapshot {
	generatedAt: number;
	cwd: string;
	agentDir: string;
	mode: ModeInfo;
	askPolicy: { baseline: string[]; whitelisted: string[] };
	extensions: ExtensionEntry[];
	core: { commands: CommandEntry[]; tools: ToolEntry[] };
	loadErrors: Array<{ path: string; error: string }>;
}

export type ExtensionsMessage =
	| { type: "getSnapshot" }
	| { type: "refresh" }
	| { type: "openSessions" }
	| { type: "openSettings" };

export type ExtensionsReply =
	| { type: "snapshot"; snapshot: ExtensionsSnapshot }
	| { type: "error"; message: string };
