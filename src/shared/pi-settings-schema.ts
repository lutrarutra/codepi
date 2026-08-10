/**
 * Declarative schema mirroring pi's Settings interface
 * (@earendil-works/pi-coding-agent, dist/core/settings-manager.d.ts).
 * Shared by the extension (validation on save) and the settings webview
 * (form rendering). Keep field keys identical to the Settings interface.
 */

export type FieldType =
	| "string"
	| "number"
	| "boolean"
	| "enum"
	| "string[]"
	| "object";

export interface SchemaField {
	key: string;
	label: string;
	type: FieldType;
	/** For type "enum": allowed values. */
	options?: string[];
	help?: string;
}

export interface SchemaSection {
	id: string;
	title: string;
	fields: SchemaField[];
}

const f = (
	key: string,
	label: string,
	type: FieldType,
	options?: string[],
	help?: string,
): SchemaField => ({ key, label, type, options, help });

export const SETTINGS_SCHEMA: SchemaSection[] = [
	{
		id: "general",
		title: "General",
		fields: [
			f("defaultProvider", "Default provider", "string", undefined, "Provider name used when no model is specified"),
			f("defaultModel", "Default model", "string", undefined, "Model id used when none is selected"),
			f("defaultThinkingLevel", "Default thinking level", "enum", ["off", "minimal", "low", "medium", "high", "xhigh"]),
			f("transport", "Transport", "string", undefined, "Provider transport (auto/stdio/socket/http)"),
			f("theme", "Theme", "string"),
			f("defaultProjectTrust", "Default project trust", "enum", ["ask", "always", "never"]),
			f("doubleEscapeAction", "Double-escape action", "enum", ["fork", "tree", "none"]),
			f("treeFilterMode", "Tree filter mode", "enum", ["default", "no-tools", "user-only", "labeled-only", "all"]),
			f("quietStartup", "Quiet startup", "boolean"),
			f("collapseChangelog", "Collapse changelog", "boolean"),
			f("enableSkillCommands", "Enable skill commands", "boolean"),
			f("hideThinkingBlock", "Hide thinking block", "boolean"),
			f("showHardwareCursor", "Show hardware cursor", "boolean"),
		],
	},
	{
		id: "behavior",
		title: "Behavior",
		fields: [
			f("steeringMode", "Steering mode", "enum", ["all", "one-at-a-time"]),
			f("followUpMode", "Follow-up mode", "enum", ["all", "one-at-a-time"]),
			f("shellPath", "Shell path", "string"),
			f("shellCommandPrefix", "Shell command prefix", "string", undefined, "e.g. shopt -s expand_aliases"),
			f("npmCommand", "npm command", "string[]", undefined, "argv-style, e.g. [\"mise\",\"exec\",\"node@20\",\"--\",\"npm\"]"),
			f("sessionDir", "Session directory", "string", undefined, "Custom session storage directory"),
			f("httpProxy", "HTTP proxy URL", "string"),
			f("httpIdleTimeoutMs", "HTTP idle timeout (ms)", "number", undefined, "0 disables"),
			f("websocketConnectTimeoutMs", "WebSocket connect timeout (ms)", "number", undefined, "0 disables"),
			f("editorPaddingX", "Editor horizontal padding", "number"),
			f("autocompleteMaxVisible", "Autocomplete max visible", "number"),
			f("lastChangelogVersion", "Last changelog version", "string"),
			f("trackingId", "Tracking id", "string"),
			f("enableInstallTelemetry", "Enable install telemetry", "boolean"),
			f("enableAnalytics", "Enable analytics", "boolean"),
		],
	},
	{
		id: "compaction",
		title: "Compaction",
		fields: [
			f("compaction", "Compaction", "object", undefined, 'JSON: {"enabled":true,"reserveTokens":16000,"keepRecentTokens":20000}'),
		],
	},
	{
		id: "retry",
		title: "Retry",
		fields: [
			f("retry", "Retry", "object", undefined, 'JSON: {"enabled":true,"maxRetries":3,"baseDelayMs":1000,"provider":{"timeoutMs":60000}}'),
			f("branchSummary", "Branch summary", "object", undefined, 'JSON: {"reserveTokens":2048,"skipPrompt":false}'),
		],
	},
	{
		id: "resources",
		title: "Resources",
		fields: [
			f("packages", "Packages", "string[]", undefined, "npm/git package sources"),
			f("extensions", "Extensions", "string[]", undefined, "local extension paths"),
			f("skills", "Skills", "string[]", undefined, "local skill paths"),
			f("prompts", "Prompts", "string[]", undefined, "local prompt template paths"),
			f("themes", "Themes", "string[]", undefined, "local theme paths"),
			f("enabledModels", "Enabled models", "string[]", undefined, "model patterns for cycling (provider/model)"),
		],
	},
	{
		id: "terminal",
		title: "Terminal / Images",
		fields: [
			f("terminal", "Terminal", "object", undefined, 'JSON: {"showImages":true,"imageWidthCells":80,"clearOnShrink":false}'),
			f("images", "Images", "object", undefined, 'JSON: {"autoResize":true,"blockImages":false}'),
			f("thinkingBudgets", "Thinking budgets", "object", undefined, 'JSON: {"minimal":1000,"low":2000,"medium":4000,"high":8000}'),
			f("markdown", "Markdown", "object", undefined, 'JSON: {"codeBlockIndent":"  "}'),
			f("warnings", "Warnings", "object", undefined, 'JSON: {"anthropicExtraUsage":false}'),
		],
	},
];

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function checkField(path: string, field: SchemaField, value: unknown, errors: string[]): void {
	switch (field.type) {
		case "string":
			if (value !== undefined && typeof value !== "string") errors.push(`${path}: expected string`);
			break;
		case "number":
			if (value !== undefined && typeof value !== "number") errors.push(`${path}: expected number`);
			break;
		case "boolean":
			if (value !== undefined && typeof value !== "boolean") errors.push(`${path}: expected boolean`);
			break;
		case "enum":
			if (value !== undefined && !field.options?.includes(String(value))) {
				errors.push(`${path}: must be one of ${field.options?.join(", ")}`);
			}
			break;
		case "string[]":
			if (value !== undefined && (!Array.isArray(value) || value.some((v) => typeof v !== "string"))) {
				errors.push(`${path}: expected array of strings`);
			}
			break;
		case "object":
			if (value !== undefined && !isPlainObject(value)) errors.push(`${path}: expected object`);
			else if (isPlainObject(value)) {
				for (const [k, v] of Object.entries(value)) {
					if (v !== undefined && !["string", "number", "boolean"].includes(typeof v) && !Array.isArray(v) && !isPlainObject(v)) {
						errors.push(`${path}.${k}: unsupported value`);
					}
				}
			}
			break;
	}
}

/** Returns field-path error strings; empty array when the value is valid. */
export function validateSettings(value: unknown): string[] {
	if (value === undefined) return [];
	if (!isPlainObject(value)) return ["settings: expected object"];
	const errors: string[] = [];
	for (const section of SETTINGS_SCHEMA) {
		for (const field of section.fields) {
			const v = (value as Record<string, unknown>)[field.key];
			checkField(field.key, field, v, errors);
		}
	}
	return errors;
}
