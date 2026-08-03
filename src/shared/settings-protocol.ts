/** Settings dashboard protocol shared by the extension and settings webview. */

export interface BundledResourceRow {
	id: "custom-footer" | "filechanges" | "codepi-modes" | "codepi-bash" | "codepi-context" | "nebula-pulse";
	label: string;
	kind: "extension" | "theme";
	enabled: boolean;
	enabledByDefault: boolean;
}

export interface PackageStatusEntry {
	source: string;
	scope: "user" | "project";
	installed: boolean;
}

export interface TerminalPrefs {
	fontFamily: string;
	fontSize: number;
}

/**
 * How CodePi verifies edited files after an agent turn (codepi.autoVerify).
 * - "nextTurn": problems are attached as context on the user's next prompt (quiet).
 * - "followUp": problems are sent immediately so the agent keeps working to fix them.
 * - "off": verification only when the agent calls get_diagnostics itself.
 */
export type AutoVerifyMode = "nextTurn" | "followUp" | "off";

export interface DashboardData {
	agentDir: string;
	sessionDir: string;
	terminalPrefs: TerminalPrefs;
	autoVerify: AutoVerifyMode;
	/** Ask-mode read-only allowlist (effective value, defaults when unset). */
	askAllowedTools: string[];
	bundledResources: BundledResourceRow[];
	packages: {
		configured: number;
		installed: number;
		missing: number;
		entries: PackageStatusEntry[];
	};
	files: {
		settings: { path: string; exists: boolean };
		models: { path: string; exists: boolean };
		auth: { path: string; exists: boolean };
	};
}

export type SettingsMessage =
	| { command: "settings:get" }
	| {
			command: "settings:setBundledResource";
			id: BundledResourceRow["id"];
			enabled: boolean;
	  }
	| {
			command: "settings:setTerminalPrefs";
			fontFamily: string;
			fontSize: number;
	  }
	| { command: "settings:setAutoVerify"; mode: AutoVerifyMode }
	| { command: "settings:setAskAllowedTools"; tools: string[] }
	| { command: "settings:openFile"; file: "settings" | "models" | "auth" }
	| { command: "settings:refresh" }
	| { command: "settings:openSessions" };

export type SettingsReply =
	| { command: "settings:data"; data: DashboardData }
	| {
			command: "settings:saved";
			ok: true;
			resource: BundledResourceRow["id"] | "terminal" | "autoVerify" | "askAllowedTools";
	  }
	| {
			command: "settings:opened";
			file: "settings" | "models" | "auth";
			path: string;
	  }
	| { command: "settings:error"; message: string };
