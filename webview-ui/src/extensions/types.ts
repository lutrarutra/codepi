/** Local mirror of src/shared/extensions-protocol.ts. */

export type SourceTag = "bundled" | "agent" | "project" | "package" | "other";
export type AskMode = "safe" | "whitelisted" | "blocked";
export type CommandSource = "extension" | "skill" | "prompt";

export interface CommandEntry {
	name: string;
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
	displayName: string;
	path: string;
	source: SourceTag;
	enabled: boolean;
	commands: CommandEntry[];
	tools: ToolEntry[];
	events: number;
	flags: number;
	shortcuts: number;
	messageRenderers: number;
}

export interface ModeInfo {
	active: boolean;
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

export type ExtensionsMessage = { type: "getSnapshot" } | { type: "refresh" };

export type ExtensionsReply =
	| { type: "snapshot"; snapshot: ExtensionsSnapshot }
	| { type: "error"; message: string };
