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
export function readBundledResourceConfig(settings: unknown): BundledResourceConfig {
	const defaults: BundledResourceConfig = {
		bundledExtensions: { "custom-footer": true, filechanges: true },
		bundledThemes: { "nebula-pulse": true },
	};
	if (!isRecord(settings) || !isRecord(settings.codepi)) return defaults;

	const codepi = settings.codepi;
	const extensions = isRecord(codepi.bundledExtensions)
		? codepi.bundledExtensions
		: undefined;
	const themes = isRecord(codepi.bundledThemes) ? codepi.bundledThemes : undefined;
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
		throw new Error(`Failed to parse ${p}: ${err instanceof Error ? err.message : String(err)}`);
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

export interface LegacyConfigDetected {
	settings: boolean;
	auth: boolean;
	models: boolean;
}

/** Detect existing config in a legacy agent dir (e.g. ~/.pi/agent). */
export function detectLegacyConfig(legacyAgentDir: string): LegacyConfigDetected | undefined {
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
