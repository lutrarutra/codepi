/**
 * Pure filesystem core for CodePi's own pi config store.
 * NO vscode imports — unit-testable. The agent directory is redirected via
 * process.env.PI_CODING_AGENT_DIR (pi's own getAgentDir() reads it at call
 * time), so everything pi reads/writes lands in the extension's storage.
 */
import { homedir } from "node:os";
import type { AutoVerifyMode } from "./shared/settings-protocol";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

/** Resolve the canonical Pi config directory for the executing computer. */
export function getCanonicalAgentDir(): string {
	return join(homedir(), ".pi", "agent");
}

/** Resolve CodePi's per-extension session directory below VS Code storage. */
export function getCodePiSessionDir(globalStoragePath: string): string {
	return join(globalStoragePath, "sessions");
}

export interface BundledResourceMetadata {
	id: "custom-footer" | "filechanges" | "codepi-modes" | "codepi-bash" | "codepi-context" | "nebula-pulse";
	label: string;
	kind: "extension" | "theme";
	enabledByDefault: boolean;
}

export const BUNDLED_RESOURCES: readonly BundledResourceMetadata[] = [
	{
		id: "custom-footer",
		label: "Custom footer",
		kind: "extension",
		enabledByDefault: true,
	},
	{
		id: "filechanges",
		label: "File changes",
		kind: "extension",
		enabledByDefault: true,
	},
	{
		id: "codepi-modes",
		label: "Agent modes (Ask / Plan / Implement)",
		kind: "extension",
		enabledByDefault: true,
	},
	{
		id: "codepi-bash",
		label: "Bash tool (VS Code terminal + approval)",
		kind: "extension",
		enabledByDefault: true,
	},
	{
		id: "codepi-context",
		label: "Editor context (snapshot + tools)",
		kind: "extension",
		enabledByDefault: true,
	},
	{
		id: "nebula-pulse",
		label: "Nebula Pulse theme",
		kind: "theme",
		enabledByDefault: true,
	},
];

// ── Terminal preferences (CodePi-owned settings.codepi.*) ─────

export const DEFAULT_TERMINAL_FONT_FAMILY = "FiraCode Nerd Font";
export const DEFAULT_TERMINAL_FONT_SIZE = 14;

export interface TerminalPrefs {
	fontFamily: string;
	fontSize: number;
}

function clampFontSize(value: number): number {
	if (!Number.isFinite(value)) return DEFAULT_TERMINAL_FONT_SIZE;
	return Math.min(40, Math.max(8, Math.round(value)));
}

/**
 * Read CodePi's terminal preferences (codepi.fontFamily / codepi.fontSize)
 * without trusting malformed settings. These are CodePi-only: pi itself has
 * no font settings, so they never collide with the SDK's SettingsManager.
 */
export function readTerminalPrefs(settings: unknown): TerminalPrefs {
	const defaults: TerminalPrefs = {
		fontFamily: DEFAULT_TERMINAL_FONT_FAMILY,
		fontSize: DEFAULT_TERMINAL_FONT_SIZE,
	};
	if (!isRecord(settings) || !isRecord(settings.codepi)) return defaults;
	const codepi = settings.codepi;
	const fontFamily =
		typeof codepi.fontFamily === "string" && codepi.fontFamily.trim() !== ""
			? codepi.fontFamily.trim()
			: defaults.fontFamily;
	const fontSize =
		typeof codepi.fontSize === "number"
			? clampFontSize(codepi.fontSize)
			: defaults.fontSize;
	return { fontFamily, fontSize };
}

/** Store CodePi's terminal preferences in settings.json (codepi.*). */
export function updateTerminalPrefs(
	settingsPath: string,
	prefs: TerminalPrefs,
): void {
	writeCodePiSettingsMerge(settingsPath, (settings) => {
		const codepi = isRecord(settings.codepi) ? { ...settings.codepi } : {};
		codepi.fontFamily = prefs.fontFamily;
		codepi.fontSize = clampFontSize(prefs.fontSize);
		return { ...settings, codepi };
	});
}

// ── Post-edit verification (codepi.autoVerify) ────────────────

export const AUTO_VERIFY_MODES: readonly AutoVerifyMode[] = [
	"nextTurn",
	"followUp",
	"off",
];
export const DEFAULT_AUTO_VERIFY_MODE: AutoVerifyMode = "nextTurn";

/**
 * Read the post-edit verification mode (codepi.autoVerify) without trusting
 * malformed settings. Default: "nextTurn" — problems from edited files are
 * attached as context on the user's next prompt.
 */
export function readAutoVerifyMode(settings: unknown): AutoVerifyMode {
	const codepi =
		isRecord(settings) && isRecord(settings.codepi) ? settings.codepi : undefined;
	const raw = codepi?.autoVerify;
	return typeof raw === "string" &&
		(AUTO_VERIFY_MODES as readonly string[]).includes(raw)
		? (raw as AutoVerifyMode)
		: DEFAULT_AUTO_VERIFY_MODE;
}

/** Store the post-edit verification mode in settings.json (codepi.*). */
export function updateAutoVerifyMode(
	settingsPath: string,
	mode: AutoVerifyMode,
): void {
	writeCodePiSettingsMerge(settingsPath, (settings) => {
		const codepi = isRecord(settings.codepi) ? { ...settings.codepi } : {};
		codepi.autoVerify = mode;
		return { ...settings, codepi };
	});
}

// ── Ask-mode allowed tools (codepi.modes.ask.allowedTools) ───

/**
 * Default Ask-mode allowlist used to seed settings.json and as the dashboard
 * display fallback. MUST stay in sync with `DEFAULT_ASK_ALLOWED_TOOLS` in
 * resources/extensions/codepi-modes.ts (the extension's runtime fallback,
 * used when the settings block is missing).
 */
export const ASK_MODE_DEFAULT_ALLOWED_TOOLS: readonly string[] = [
	"read",
	"grep",
	"find",
	"ls",
	"list_dir",
	"find_files",
	"get_diagnostics",
	"ask_user_question",
	"web_search",
	"fetch_content",
	// codepi-context tools are pure reads of editor/git state — safe in
	// read-only mode (the session snapshot tells the agent to call
	// get_editor_context for live state).
	"get_editor_context",
	"get_git_diff",
];

/**
 * The Ask-mode allowlist as seeded before codepi-context existed. Used to
 * migrate settings.json files that were auto-seeded with the old default, so
 * the (read-only) context tools become available in Ask mode too.
 */
export const ASK_MODE_DEFAULT_ALLOWED_TOOLS_PRE_CONTEXT: readonly string[] = [
	"read",
	"grep",
	"find",
	"ls",
	"list_dir",
	"find_files",
	"get_diagnostics",
	"ask_user_question",
	"web_search",
	"fetch_content",
];

/** Settings path to the Ask-mode allowlist: codepi.modes.ask.allowedTools. */
export const ASK_MODE_ALLOWED_TOOLS_KEY = [
	"codepi",
	"modes",
	"ask",
	"allowedTools",
] as const;

/**
 * Read the Ask-mode allowlist. Returns undefined when the settings block is
 * missing entirely (callers fall back to ASK_MODE_DEFAULT_ALLOWED_TOOLS); an
 * explicitly empty list is respected as the user's choice. Malformed values
 * are dropped, entries are trimmed and deduplicated.
 */
export function readAskModeAllowedTools(
	settings: unknown,
): string[] | undefined {
	let value: unknown = settings;
	for (const key of ASK_MODE_ALLOWED_TOOLS_KEY) {
		if (!isRecord(value)) return undefined;
		value = value[key];
	}
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) return undefined;
	const seen = new Set<string>();
	const out: string[] = [];
	for (const item of value) {
		if (typeof item !== "string") continue;
		const tool = item.trim();
		if (tool === "" || seen.has(tool)) continue;
		seen.add(tool);
		out.push(tool);
	}
	return out;
}

/** Store the Ask-mode allowlist in settings.json (codepi.modes.ask.*). */
export function updateAskModeAllowedTools(
	settingsPath: string,
	tools: readonly string[],
): void {
	const cleaned = [...new Set(tools.map((t) => t.trim()).filter((t) => t !== ""))];
	writeCodePiSettingsMerge(settingsPath, (settings) => {
		const codepi = isRecord(settings.codepi) ? { ...settings.codepi } : {};
		const modes = isRecord(codepi.modes) ? { ...codepi.modes } : {};
		const ask = isRecord(modes.ask) ? { ...modes.ask } : {};
		ask.allowedTools = cleaned;
		modes.ask = ask;
		codepi.modes = modes;
		return { ...settings, codepi };
	});
}

/**
 * Write the default Ask-mode allowlist into settings.json when the block is
 * missing, so users can find and edit it. No-op when already present.
 */
export function seedAskModeAllowedToolsIfMissing(settingsPath: string): void {
	const settings = readJsonFile<Record<string, unknown>>(settingsPath);
	const current = readAskModeAllowedTools(settings);
	if (current === undefined) {
		updateAskModeAllowedTools(settingsPath, ASK_MODE_DEFAULT_ALLOWED_TOOLS);
		return;
	}
	// Migrate a settings.json that was auto-seeded with the pre-context
	// default: the context tools are pure reads, so they belong in the
	// read-only allowlist. Only exact matches of the old default are touched;
	// user-customized lists are left alone.
	const oldDefault = new Set(ASK_MODE_DEFAULT_ALLOWED_TOOLS_PRE_CONTEXT);
	if (
		current.length === oldDefault.size &&
		current.every((tool) => oldDefault.has(tool))
	) {
		updateAskModeAllowedTools(settingsPath, ASK_MODE_DEFAULT_ALLOWED_TOOLS);
	}
}

export interface BundledResourceConfig {
	bundledExtensions: {
		"custom-footer": boolean;
		filechanges: boolean;
		"codepi-modes": boolean;
		"codepi-bash": boolean;
		"codepi-context": boolean;
	};
	bundledThemes: {
		"nebula-pulse": boolean;
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read CodePi's bundled-resource toggles without trusting malformed settings. */
export function readBundledResourceConfig(
	settings: unknown,
): BundledResourceConfig {
	const defaults: BundledResourceConfig = {
		bundledExtensions: {
			"custom-footer": true,
			filechanges: true,
			"codepi-modes": true,
			"codepi-bash": true,
			"codepi-context": true,
		},
		bundledThemes: { "nebula-pulse": true },
	};
	if (!isRecord(settings) || !isRecord(settings.codepi)) return defaults;

	const codepi = settings.codepi;
	const extensions = isRecord(codepi.bundledExtensions)
		? codepi.bundledExtensions
		: undefined;
	const themes = isRecord(codepi.bundledThemes)
		? codepi.bundledThemes
		: undefined;
	return {
		bundledExtensions: {
			"custom-footer":
				typeof extensions?.["custom-footer"] === "boolean"
					? extensions["custom-footer"]
					: defaults.bundledExtensions["custom-footer"],
			filechanges:
				typeof extensions?.filechanges === "boolean"
					? extensions.filechanges
					: defaults.bundledExtensions.filechanges,
			"codepi-modes":
				typeof extensions?.["codepi-modes"] === "boolean"
					? extensions["codepi-modes"]
					: defaults.bundledExtensions["codepi-modes"],
			"codepi-bash":
				typeof extensions?.["codepi-bash"] === "boolean"
					? extensions["codepi-bash"]
					: defaults.bundledExtensions["codepi-bash"],
			"codepi-context":
				typeof extensions?.["codepi-context"] === "boolean"
					? extensions["codepi-context"]
					: defaults.bundledExtensions["codepi-context"],
		},
		bundledThemes: {
			"nebula-pulse":
				typeof themes?.["nebula-pulse"] === "boolean"
					? themes["nebula-pulse"]
					: defaults.bundledThemes["nebula-pulse"],
		},
	};
}

/**
 * Whether the codepi-bash bundled extension is enabled in settings
 * (default true). When disabled, extension.ts registers pi's builtin bash
 * tool instead so the agent still has a working (stock) bash.
 */
export function isBashExtensionEnabled(settings: unknown): boolean {
	return readBundledResourceConfig(settings).bundledExtensions["codepi-bash"];
}

/** Whether the codepi-context bundled extension is enabled in settings */
export function isContextExtensionEnabled(settings: unknown): boolean {
	return readBundledResourceConfig(settings).bundledExtensions["codepi-context"];
}

/** Return the bundled resources enabled by the current CodePi settings. */
export function getEnabledBundledResources(
	settings: unknown,
): BundledResourceMetadata[] {
	const config = readBundledResourceConfig(settings);
	return BUNDLED_RESOURCES.filter((resource) =>
		resource.kind === "extension"
			? config.bundledExtensions[
					resource.id as
						| "custom-footer"
						| "filechanges"
						| "codepi-modes"
						| "codepi-bash"
						| "codepi-context"
				]
			: config.bundledThemes["nebula-pulse"],
	).map((resource) => ({ ...resource }));
}

export function getAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || getCanonicalAgentDir();
}

export function setAgentDir(dir: string): void {
	process.env.PI_CODING_AGENT_DIR = dir;
}

export function getSettingsPath(): string {
	return join(getAgentDir(), "settings.json");
}

export function getAuthPath(): string {
	return join(getAgentDir(), "auth.json");
}

export function getModelsPath(): string {
	return join(getAgentDir(), "models.json");
}

/** Read a JSON file; undefined when missing; throws Error on parse failure. */
export function readJsonFile<T>(p: string): T | undefined {
	if (!existsSync(p)) return undefined;
	const raw = readFileSync(p, "utf8");
	try {
		return JSON.parse(raw) as T;
	} catch (err) {
		throw new Error(
			`Failed to parse ${p}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

/** Atomic write: tmp file in the same directory + rename. Creates parents. */
export function writeJsonFileAtomic(p: string, value: unknown): void {
	const dir = dirname(p);
	mkdirSync(dir, { recursive: true });
	const tmp = `${p}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
	renameSync(tmp, p);
}

export type CodePiSettingsUpdater = (
	settings: Record<string, unknown>,
) => Record<string, unknown>;

export type CodePiSettingsMergeOptions = {
	/** Test seam invoked after the initial read and before the change check. */
	beforeWriteCheck?: (attempt: number) => void;
};

function readSettingsContent(p: string): string | undefined {
	try {
		return readFileSync(p, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw err;
	}
}

function parseSettingsContent(
	settingsPath: string,
	raw: string | undefined,
): Record<string, unknown> {
	if (raw === undefined) return {};
	try {
		return JSON.parse(raw) as Record<string, unknown>;
	} catch (err) {
		throw new Error(
			`Failed to parse ${settingsPath}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

/**
 * Read, update, and atomically write settings while preserving unknown keys.
 *
 * The SDK's SettingsManager owns its lock when it writes known Pi settings.
 * CodePi's namespaced key is intentionally outside that API, so this helper
 * re-reads the complete file immediately before the atomic rename. A caller
 * that observes changed content gets one retry against the newest file rather
 * than clobbering the other writer's changes.
 */
export function writeCodePiSettingsMerge(
	settingsPath: string,
	updater: CodePiSettingsUpdater,
	options?: CodePiSettingsMergeOptions,
): void {
	for (let attempt = 0; attempt < 2; attempt++) {
		const initialContent = readSettingsContent(settingsPath);
		const current = parseSettingsContent(settingsPath, initialContent);
		const next = updater({ ...current });
		options?.beforeWriteCheck?.(attempt);
		const latestContent = readSettingsContent(settingsPath);
		if (latestContent !== initialContent) continue;
		writeJsonFileAtomic(settingsPath, next);
		return;
	}
	throw new Error(
		`Settings changed while updating ${settingsPath}; please retry.`,
	);
}

export type PiJsonFile = "settings" | "models" | "auth";

/** Return a Pi JSON path below an agent directory, creating missing files. */
export function ensurePiJsonFileInDir(
	agentDir: string,
	file: PiJsonFile,
): string {
	const filename = `${file}.json`;
	const target = join(agentDir, filename);
	if (!existsSync(target)) writeJsonFileAtomic(target, {});
	if (file === "auth") {
		// AuthStorage expects owner-only credentials on POSIX systems.
		try {
			chmodSync(target, 0o600);
		} catch {
			/* non-POSIX — ignore */
		}
	}
	return target;
}

/** Return a Pi JSON path in the configured canonical agent directory. */
export function ensurePiJsonFile(file: PiJsonFile): string {
	return ensurePiJsonFileInDir(getAgentDir(), file);
}

/** Update only CodePi's bundled-resource preferences in settings.json. */
export function updateBundledResourceConfig(
	settingsPath: string,
	config: BundledResourceConfig,
): void {
	writeCodePiSettingsMerge(settingsPath, (settings) => {
		const codepi = isRecord(settings.codepi) ? { ...settings.codepi } : {};
		codepi.bundledExtensions = { ...config.bundledExtensions };
		codepi.bundledThemes = { ...config.bundledThemes };
		return { ...settings, codepi };
	});
}

/**
 * Seed `<agentDir>/bin` with the fd/rg binaries pi's TUI waits for at
 * startup. pi's `ensureTool()` otherwise downloads them over the network
 * while init() awaits them — which makes the first seconds of a session
 * look frozen. rg ships with this extension (@vscode/ripgrep-universal);
 * fd is copied from a legacy `~/.pi/agent/bin` (or `~/.pi/bin`) when
 * present. Idempotent; never overwrites an existing binary.
 */
export async function ensureRuntimeTools(agentDir: string): Promise<void> {
	const binDir = join(agentDir, "bin");
	mkdirSync(binDir, { recursive: true });

	const rgName = process.platform === "win32" ? "rg.exe" : "rg";
	const rgDest = join(binDir, rgName);
	if (!existsSync(rgDest)) {
		try {
			const mod = await import("@vscode/ripgrep-universal");
			copyBinary(mod.rgPath, rgDest);
		} catch {
			// rg unavailable — pi's ensureTool downloads it later if needed.
		}
	}

	const fdName = process.platform === "win32" ? "fd.exe" : "fd";
	const fdDest = join(binDir, fdName);
	if (!existsSync(fdDest)) {
		for (const srcDir of [
			join(homedir(), ".pi", "agent", "bin"),
			join(homedir(), ".pi", "bin"),
		]) {
			const src = join(srcDir, fdName);
			try {
				if (existsSync(src)) {
					copyBinary(src, fdDest);
					break;
				}
			} catch {
				/* unreadable/copy failed — try next source */
			}
		}
	}
}

/** Copy a binary and make it executable (spawnSync needs +x). */
function copyBinary(src: string, dest: string): void {
	cpSync(src, dest);
	chmodSync(dest, 0o755);
}

export interface LegacyConfigDetected {
	settings: boolean;
	auth: boolean;
	models: boolean;
}

/** Detect existing config in a legacy agent dir (e.g. ~/.pi/agent). */
export function detectLegacyConfig(
	legacyAgentDir: string,
): LegacyConfigDetected | undefined {
	const found: LegacyConfigDetected = {
		settings: existsSync(join(legacyAgentDir, "settings.json")),
		auth: existsSync(join(legacyAgentDir, "auth.json")),
		models: existsSync(join(legacyAgentDir, "models.json")),
	};
	return found.settings || found.auth || found.models ? found : undefined;
}

export interface MigrationResult {
	copiedFiles: string[];
	copiedSessions: string[];
	skippedFiles: string[];
	sessionsSkipped?: "missing-source" | "destination-not-empty";
}

/**
 * Migrate storage written by older CodePi versions.
 *
 * The source session directory is passed explicitly because the canonical Pi
 * agent directory may also contain Pi CLI sessions. This helper never derives
 * or inspects `<canonicalAgentDir>/sessions`.
 */
export function migrateLegacyCodePiStorage(
	legacyAgentDir: string,
	canonicalAgentDir: string,
	legacySessionDir: string,
	codePiSessionDir: string,
): MigrationResult {
	mkdirSync(canonicalAgentDir, { recursive: true });
	const copiedFiles: string[] = [];
	const skippedFiles: string[] = [];
	for (const file of ["settings.json", "auth.json", "models.json"]) {
		const source = join(legacyAgentDir, file);
		const target = join(canonicalAgentDir, file);
		if (!existsSync(source) || !statSync(source).isFile()) continue;
		if (existsSync(target)) {
			skippedFiles.push(file);
			continue;
		}
		cpSync(source, target);
		if (file === "auth.json") {
			try {
				chmodSync(target, 0o600);
			} catch {
				/* non-POSIX — ignore */
			}
		}
		copiedFiles.push(file);
	}

	if (
		!existsSync(legacySessionDir) ||
		!statSync(legacySessionDir).isDirectory()
	) {
		return {
			copiedFiles,
			copiedSessions: [],
			skippedFiles,
			sessionsSkipped: "missing-source",
		};
	}
	mkdirSync(codePiSessionDir, { recursive: true });
	if (readdirSync(codePiSessionDir).length > 0) {
		return {
			copiedFiles,
			copiedSessions: [],
			skippedFiles,
			sessionsSkipped: "destination-not-empty",
		};
	}
	cpSync(legacySessionDir, codePiSessionDir, { recursive: true });
	const copiedSessions = readdirSync(legacySessionDir);
	return { copiedFiles, copiedSessions, skippedFiles };
}
