/**
 * Settings GUI protocol shared by the extension and the settings webview.
 * NO vscode imports. The webview does NOT import this file — it keeps a
 * local mirror of these types in webview-ui/src/settings/types.ts; keep the
 * two in sync when changing messages here.
 */

/**
 * Structural stand-in for pi's `Settings` interface
 * (@earendil-works/pi-coding-agent/dist/core/settings-manager.d.ts).
 *
 * The SDK package is ESM-only and its index does NOT re-export the `Settings`
 * type, so the extension (CJS bundle) cannot type-import it. This local shape
 * keeps the protocol self-contained; pi's own validation still applies on save
 * (see validateSettings in pi-settings-schema.ts).
 */
export interface SettingsRecord {
	[key: string]: unknown;
}

/** Webview → extension */
export type SettingsMessage =
	| { command: "settings:get" }
	| { command: "settings:saveSettings"; settings: SettingsRecord }
	| { command: "settings:saveAuth"; provider: string; key?: string; remove?: boolean }
	| { command: "settings:saveModels"; models: unknown }
	| { command: "settings:saveJson"; file: "settings" | "models"; text: string }
	| { command: "settings:importConfig" }
	| { command: "settings:openSessions" };

export interface AuthEntry {
	provider: string;
	type: "api_key" | "oauth";
	hasKey: boolean;
}

/** Extension → webview */
export type SettingsReply =
	| {
			command: "settings:data";
			settings: SettingsRecord;
			auth: AuthEntry[];
			models: unknown;
			modelsError?: string;
			catalog: Array<{ provider: string; modelId: string }>;
	  }
	| { command: "settings:saved"; ok: true; file?: string }
	| { command: "settings:error"; message: string; file?: string }
	| { command: "settings:importResult"; imported: string[]; message: string };
