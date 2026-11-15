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
	/** Display name of the enabled extension that overrides this tool, if any. */
	overriddenBy?: string;
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
