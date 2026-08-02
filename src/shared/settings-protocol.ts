/** Settings dashboard protocol shared by the extension and settings webview. */

export interface BundledResourceRow {
	id: "custom-footer" | "filechanges" | "nebula-pulse";
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

export interface DashboardData {
	agentDir: string;
	sessionDir: string;
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
	| { command: "settings:openFile"; file: "settings" | "models" | "auth" }
	| { command: "settings:refresh" }
	| { command: "settings:openSessions" };

export type SettingsReply =
	| { command: "settings:data"; data: DashboardData }
	| { command: "settings:saved"; ok: true; resource: BundledResourceRow["id"] }
	| { command: "settings:opened"; file: "settings" | "models" | "auth"; path: string }
	| { command: "settings:error"; message: string };
