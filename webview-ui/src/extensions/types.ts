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
	/** Display name of the enabled extension that overrides this tool, if any. */
	overriddenBy?: string;
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

/** A pi package from settings.json `packages` (user) or .pi/settings.json (project). */
export interface PackageEntry {
	source: string;
	scope: "user" | "project";
	/** Installed on disk (npm/git packages are installed by pi on load). */
	installed: boolean;
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
	/** Configured pi packages (absent from older hosts). */
	packages?: PackageEntry[];
}

export type ExtensionsMessage =
	| { type: "getSnapshot" }
	| { type: "refresh" }
	| { type: "openSessions" }
	| { type: "openSettings" }
	| { type: "installPackage"; source: string }
	| { type: "removePackage"; source: string; scope: "user" | "project" }
	| { type: "updatePackages"; source?: string };

export type ExtensionsReply =
	| { type: "snapshot"; snapshot: ExtensionsSnapshot }
	| { type: "error"; message: string }
	| { type: "packageBusy"; message: string }
	| { type: "packageDone"; ok: boolean; message: string };
