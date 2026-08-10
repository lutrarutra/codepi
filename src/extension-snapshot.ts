/** Pure snapshot construction for the Extensions sidebar tab.
 *
 * This module must stay free of `vscode` imports and static SDK imports so it
 * can be unit-tested in vitest. The probe (extensions-view.ts) supplies raw
 * loader objects; everything here is deterministic functions. */
import { basename } from "node:path";
import { ASK_MODE_DEFAULT_ALLOWED_TOOLS } from "./pi-store";
import type {
	AskMode,
	CommandEntry,
	CommandSource,
	ExtensionEntry,
	ExtensionsSnapshot,
	ModeInfo,
	SourceTag,
	ToolEntry,
} from "./shared/extensions-protocol";

/** Settings path for the Ask-mode whitelist: codepi.modes.ask.allowedTools. */
export const ASK_ALLOWED_TOOLS_KEY = ["codepi", "modes", "ask", "allowedTools"];

/**
 * Mirror of the SDK's BUILTIN_SLASH_COMMANDS (dist/core/slash-commands.js),
 * which is not re-exported from the package root. The SDK version is pinned
 * via patch-package (patches/@earendil-works+pi-coding-agent+0.83.0.patch);
 * refresh this list if the pinned SDK changes it.
 */
export const CORE_SLASH_COMMANDS: ReadonlyArray<{
	name: string;
	description: string;
}> = [
	{ name: "settings", description: "Open settings menu" },
	{ name: "model", description: "Select model (opens selector UI)" },
	{
		name: "scoped-models",
		description: "Enable/disable models for Ctrl+P cycling",
	},
	{
		name: "export",
		description: "Export session (HTML default, or specify path: .html/.jsonl)",
	},
	{
		name: "import",
		description: "Import and resume a session from a JSONL file",
	},
	{ name: "share", description: "Share session as a secret GitHub gist" },
	{ name: "copy", description: "Copy last agent message to clipboard" },
	{ name: "name", description: "Set session display name" },
	{ name: "session", description: "Show session info and stats" },
	{ name: "changelog", description: "Show changelog entries" },
	{ name: "hotkeys", description: "Show all keyboard shortcuts" },
	{
		name: "fork",
		description: "Create a new fork from a previous user message",
	},
	{
		name: "clone",
		description: "Duplicate the current session at the current position",
	},
	{ name: "tree", description: "Navigate session tree (switch branches)" },
	{
		name: "trust",
		description: "Save project trust decision for future sessions",
	},
	{ name: "login", description: "Configure provider authentication" },
	{ name: "logout", description: "Remove provider authentication" },
	{ name: "new", description: "Start a new session" },
	{ name: "compact", description: "Manually compact the session context" },
	{ name: "resume", description: "Resume a different session" },
	{
		name: "reload",
		description: "Reload keybindings, extensions, skills, prompts, and themes",
	},
	{ name: "quit", description: "Quit pi" },
];

/** Rich view of a loaded SDK extension as the probe sees it. */
export interface LoadedExtensionRich {
	resolvedPath?: string;
	path?: string;
	commands?: Map<string, { name?: string; description?: string }>;
	tools?: Map<
		string,
		{ definition?: { name?: string; label?: string; description?: string } }
	>;
	flags?: Map<string, unknown>;
	shortcuts?: Map<string, unknown>;
	handlers?: Map<string, unknown>;
	messageRenderers?: Map<string, unknown>;
}

export interface SnapshotRoots {
	bundledDir: string;
	agentDir: string;
	cwd: string;
}

export interface BuildSnapshotInput extends SnapshotRoots {
	settings: unknown;
	mode: ModeInfo;
	extensions: LoadedExtensionRich[];
	loadErrors: Array<{ path: string; error: string }>;
	coreCommands: CommandEntry[];
	/** Raw tool definitions (name/label/description); askMode is computed here. */
	coreTools: Array<{ name?: string; label?: string; description?: string }>;
	generatedAt?: number;
}

function normalize(p: string): string {
	return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** Classify an extension path into a SourceTag. Pure path prefix logic. */
export function classifySource(path: string, roots: SnapshotRoots): SourceTag {
	const p = normalize(path);
	const under = (root: string): boolean => {
		const r = normalize(root);
		if (!r) return false;
		return p === r || p.startsWith(r.endsWith("/") ? r : r + "/");
	};
	if (roots.bundledDir && under(roots.bundledDir)) return "bundled";
	if (under(normalize(roots.agentDir) + "/extensions")) return "agent";
	if (under(normalize(roots.cwd) + "/.pi/extensions")) return "project";
	if (p.includes("/node_modules/")) return "package";
	return "other";
}

/** "codepi-bash.ts" → "codepi-bash"; subdir entry points (dir/index.ts)
 * → directory name; npm package paths → "@scope/name". */
export function deriveDisplayName(path: string): string {
	const p = normalize(path);
	const base = basename(p).replace(/\.(ts|js|mjs|cjs)$/i, "");
	const nm = p.lastIndexOf("/node_modules/");
	if (nm !== -1) {
		const rest = p.slice(nm + "/node_modules/".length);
		const parts = rest.split("/");
		if (parts[0]?.startsWith("@")) return parts.slice(0, 2).join("/");
		return parts[0] ?? base;
	}
	// Subdirectory extensions (dir/index.ts) display as the directory name.
	if (base === "index") {
		const slash = p.lastIndexOf("/");
		if (slash > 0) {
			const parent = p.slice(0, slash).split("/").pop();
			if (parent) return parent;
		}
	}
	return base;
}

/** Ask-mode policy: explicit whitelist wins, then baseline, else blocked. */
export function computeAskMode(
	toolName: string,
	baseline: readonly string[],
	whitelist: ReadonlySet<string>,
): AskMode {
	if (whitelist.has(toolName)) return "whitelisted";
	if (baseline.includes(toolName)) return "safe";
	return "blocked";
}

/** Latest mode from session-branch custom entries (codepi-modes:mode). */
export function modeFromSessionBranch(
	branch: readonly unknown[],
): "ask" | "plan" | "implement" | undefined {
	let mode: "ask" | "plan" | "implement" | undefined;
	for (const entry of branch) {
		if (!entry || typeof entry !== "object") continue;
		const e = entry as { type?: unknown; customType?: unknown; data?: unknown };
		if (e.type !== "custom" || e.customType !== "codepi-modes:mode") continue;
		const data = (e.data ?? {}) as { mode?: unknown };
		if (
			data.mode === "ask" ||
			data.mode === "plan" ||
			data.mode === "implement"
		) {
			mode = data.mode;
		}
	}
	return mode;
}

/** Read codepi.modes.ask.allowedTools from a settings object. Defensive. */
export function readAskAllowedToolsFromSettings(settings: unknown): string[] {
	let value: unknown = settings;
	for (const key of ASK_ALLOWED_TOOLS_KEY) {
		if (value === null || typeof value !== "object") return [];
		value = (value as Record<string, unknown>)[key];
	}
	if (!Array.isArray(value)) return [];
	return value.filter((v): v is string => typeof v === "string");
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return v !== null && typeof v === "object" && !Array.isArray(v);
}

function commandEntry(
	name: string,
	reg: { name?: string; description?: string } | undefined,
): CommandEntry {
	return {
		name: reg?.name ?? name,
		...(reg?.description ? { description: reg.description } : {}),
		source: "extension" as CommandSource,
	};
}

function toolEntry(
	name: string,
	def: { name?: string; label?: string; description?: string } | undefined,
	baseline: readonly string[],
	whitelist: ReadonlySet<string>,
): ToolEntry {
	const toolName = def?.name ?? name;
	return {
		name: toolName,
		label: def?.label ?? toolName,
		description: def?.description ?? "",
		askMode: computeAskMode(toolName, baseline, whitelist),
	};
}

/** Build the full JSON-safe snapshot. */
export function buildSnapshot(input: BuildSnapshotInput): ExtensionsSnapshot {
	const baseline = [...ASK_MODE_DEFAULT_ALLOWED_TOOLS];
	const whitelisted = readAskAllowedToolsFromSettings(input.settings);
	const whitelist = new Set(whitelisted);
	const roots: SnapshotRoots = {
		bundledDir: input.bundledDir,
		agentDir: input.agentDir,
		cwd: input.cwd,
	};
	// Bundled toggles: codepi.bundledExtensions.<id> — id matches displayName
	// for bundled extensions (codepi-footer, codepi-diff, codepi-modes,
	// codepi-bash, codepi-context, codepi-task).
	const s = isRecord(input.settings) ? input.settings : {};
	const codepi = isRecord(s.codepi) ? s.codepi : {};
	const bundledConfig = isRecord(codepi.bundledExtensions)
		? codepi.bundledExtensions
		: {};

	const extensions: ExtensionEntry[] = input.extensions.map((ext) => {
		const path = ext.resolvedPath ?? ext.path ?? "";
		const commands: CommandEntry[] = [];
		for (const [name, reg] of ext.commands ?? []) {
			commands.push(commandEntry(name, reg));
		}
		const tools: ToolEntry[] = [];
		for (const [name, tool] of ext.tools ?? []) {
			tools.push(toolEntry(name, tool?.definition, baseline, whitelist));
		}
		const source = classifySource(path, roots);
		const enabled =
			source !== "bundled" || bundledConfig[deriveDisplayName(path)] !== false;
		return {
			displayName: deriveDisplayName(path),
			path,
			source,
			enabled,
			commands,
			tools,
			events: ext.handlers?.size ?? 0,
			flags: ext.flags?.size ?? 0,
			shortcuts: ext.shortcuts?.size ?? 0,
			messageRenderers: ext.messageRenderers?.size ?? 0,
		};
	});

	const coreToolsAll: ToolEntry[] = input.coreTools.map((def) =>
		toolEntry(def?.name ?? "?", def, baseline, whitelist),
	);

	// Deduplicate core tools by name: later registrations override earlier
	// ones (same Map.set ordering as the runtime). Mark earlier duplicates.
	const seenNames = new Set<string>();
	const coreTools: ToolEntry[] = [];
	for (let i = coreToolsAll.length - 1; i >= 0; i--) {
		const tool = coreToolsAll[i];
		if (seenNames.has(tool.name)) {
			tool.overriddenBy = "CodePi (host)";
			coreTools.unshift(tool);
		} else {
			seenNames.add(tool.name);
			coreTools.unshift(tool);
		}
	}

	// Detect core tools overridden by enabled extensions.
	const enabledExtToolNames = new Map<string, string>();
	for (const ext of extensions) {
		if (!ext.enabled) continue;
		for (const tool of ext.tools) {
			enabledExtToolNames.set(tool.name, ext.displayName);
		}
	}
	for (const tool of coreTools) {
		// Host override takes precedence over extension override labeling.
		if (tool.overriddenBy) continue;
		const overridingExt = enabledExtToolNames.get(tool.name);
		if (overridingExt) {
			tool.overriddenBy = overridingExt;
		}
	}

	return {
		generatedAt: input.generatedAt ?? Date.now(),
		cwd: input.cwd,
		agentDir: input.agentDir,
		mode: input.mode,
		askPolicy: { baseline, whitelisted },
		extensions,
		core: { commands: input.coreCommands, tools: coreTools },
		loadErrors: input.loadErrors,
	};
}
