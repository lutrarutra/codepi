/** Local mirror of src/shared/settings-protocol.ts (avoids importing the
 *  ESM-only SDK type into the webview tsconfig). */

export interface SettingsRecord {
	[key: string]: unknown;
}

export interface AuthEntry {
	provider: string;
	type: "api_key" | "oauth";
	hasKey: boolean;
}

export interface CatalogEntry {
	provider: string;
	modelId: string;
}

export type SettingsMessage =
	| { command: "settings:get" }
	| { command: "settings:saveSettings"; settings: SettingsRecord }
	| { command: "settings:saveAuth"; provider: string; key?: string; remove?: boolean }
	| { command: "settings:saveModels"; models: unknown }
	| { command: "settings:saveJson"; file: "settings" | "models"; text: string }
	| { command: "settings:importConfig" }
	| { command: "settings:openSessions" };

export type SettingsReply =
	| {
			command: "settings:data";
			settings: SettingsRecord;
			auth: AuthEntry[];
			models: unknown;
			modelsError?: string;
			catalog: CatalogEntry[];
	  }
	| { command: "settings:saved"; ok: true; file?: string }
	| { command: "settings:error"; message: string; file?: string }
	| { command: "settings:importResult"; imported: string[]; message: string };
