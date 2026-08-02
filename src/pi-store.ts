/**
 * Pure filesystem core for CodePi's own pi config store.
 * NO vscode imports — unit-testable. The agent directory is redirected via
 * process.env.PI_CODING_AGENT_DIR (pi's own getAgentDir() reads it at call
 * time), so everything pi reads/writes lands in the extension's storage.
 */
import { homedir } from "node:os";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
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
	id: "custom-footer" | "filechanges" | "nebula-pulse";
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
		id: "nebula-pulse",
		label: "Nebula Pulse theme",
		kind: "theme",
		enabledByDefault: true,
	},
];

export interface BundledResourceConfig {
	bundledExtensions: {
		"custom-footer": boolean;
		filechanges: boolean;
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
		bundledExtensions: { "custom-footer": true, filechanges: true },
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
		},
		bundledThemes: {
			"nebula-pulse":
				typeof themes?.["nebula-pulse"] === "boolean"
					? themes["nebula-pulse"]
					: defaults.bundledThemes["nebula-pulse"],
		},
	};
}

/** Return the bundled resources enabled by the current CodePi settings. */
export function getEnabledBundledResources(
	settings: unknown,
): BundledResourceMetadata[] {
	const config = readBundledResourceConfig(settings);
	return BUNDLED_RESOURCES.filter((resource) =>
		resource.kind === "extension"
			? config.bundledExtensions[resource.id as "custom-footer" | "filechanges"]
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

type SettingsSnapshot = {
	exists: boolean;
	mtimeMs?: number;
	size?: number;
};

function getSettingsSnapshot(p: string): SettingsSnapshot {
	try {
		const info = statSync(p);
		return { exists: true, mtimeMs: info.mtimeMs, size: info.size };
	} catch {
		return { exists: false };
	}
}

function sameSettingsSnapshot(a: SettingsSnapshot, b: SettingsSnapshot): boolean {
	return (
		a.exists === b.exists &&
		a.mtimeMs === b.mtimeMs &&
		a.size === b.size
	);
}

/**
 * Read, update, and atomically write settings while preserving unknown keys.
 *
 * The SDK's SettingsManager owns its lock when it writes known Pi settings.
 * CodePi's namespaced key is intentionally outside that API, so this helper
 * performs a stale-read check immediately before the atomic rename. A caller
 * that observes a concurrent writer gets one retry against the newest file
 * rather than clobbering the other writer's changes.
 */
export function writeCodePiSettingsMerge(
	settingsPath: string,
	updater: CodePiSettingsUpdater,
): void {
	for (let attempt = 0; attempt < 2; attempt++) {
		const initialSnapshot = getSettingsSnapshot(settingsPath);
		const current = readJsonFile<Record<string, unknown>>(settingsPath) ?? {};
		const next = updater({ ...current });
		const beforeWrite = getSettingsSnapshot(settingsPath);
		if (!sameSettingsSnapshot(initialSnapshot, beforeWrite)) continue;
		writeJsonFileAtomic(settingsPath, next);
		return;
	}
	throw new Error(`Settings changed while updating ${settingsPath}; please retry.`);
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
 * The theme shipped with this extension (resources/themes/nebula-pulse.json)
 * and used as the TUI default via settings.json's `theme` key.
 */
export const DEFAULT_THEME = "nebula-pulse";

/**
 * Make the bundled theme the TUI default: ensure settings.json selects it.
 * Only writes when the `theme` key is absent, so a theme chosen later in the
 * settings UI (or imported from a legacy config) is never overwritten.
 */
export function ensureDefaultTheme(): void {
	const settingsPath = getSettingsPath();
	const settings = readJsonFile<Record<string, unknown>>(settingsPath) ?? {};
	if (typeof settings.theme === "string") {
		// A theme was chosen explicitly — respect it.
		return;
	}
	settings.theme = DEFAULT_THEME;
	writeJsonFileAtomic(settingsPath, settings);
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

export interface ImportResult {
	imported: string[];
}

/** Copy legacy config (and optionally sessions) into the target agent dir. */
export function importLegacyConfig(
	legacyAgentDir: string,
	targetAgentDir: string,
	opts: { includeSessions: boolean },
): ImportResult {
	mkdirSync(targetAgentDir, { recursive: true });
	const imported: string[] = [];
	for (const file of ["settings.json", "auth.json", "models.json"]) {
		const src = join(legacyAgentDir, file);
		if (!existsSync(src)) continue;
		const dest = join(targetAgentDir, file);
		cpSync(src, dest, { force: true });
		if (file === "auth.json") {
			// Keep pi's credential file permission: owner rw only.
			try {
				chmodSync(dest, 0o600);
			} catch {
				/* non-POSIX — ignore */
			}
		}
		imported.push(file);
	}
	if (opts.includeSessions) {
		const srcSessions = join(legacyAgentDir, "sessions");
		if (existsSync(srcSessions) && statSync(srcSessions).isDirectory()) {
			cpSync(srcSessions, join(targetAgentDir, "sessions"), {
				recursive: true,
				force: true,
			});
			imported.push("sessions/");
		}
	}
	return { imported };
}
