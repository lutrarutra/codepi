/**
 * codepi-terminal-shortcut — `codepi` session launcher for integrated terminals.
 *
 * Injects a PATH entry into every VS Code integrated terminal (when shell
 * integration is ready) pointing at a generated `codepi` executable, so typing
 * `codepi` in the terminal opens a NEW CodePi session in the running window
 * (the `codepi.newSession` command). The shortcut exists only inside VS Code
 * terminals: nothing is installed on the system and external terminals never
 * see it.
 *
 * How the launcher reaches the window:
 * - The generated script runs `code --command codepi.newSession`. The code CLI
 *   is resolved at generation time via `<appRoot>/bin/code` (the CLI shim
 *   bundled inside the app — works for both stable and Insiders), falling back
 *   to `code` on PATH.
 * - Injection is one `sendText` per terminal at shell-integration-ready time
 *   (a fresh prompt, safe to type into). bash/zsh/sh, fish and pwsh/cmd get
 *   their native PATH syntax; unknown shells are skipped.
 *
 * Gated by the `codepi.terminalShortcut` agent setting (default true) — the
 * same settings.json convention as codepi.tasks.* / codepi.autoVerify.
 */
import * as fs from "node:fs";
import { dirname, join } from "node:path";
import * as vscode from "vscode";

export const BIN_DIR_NAME = "codepi-bin";
export const SHORTCUT_SETTING = "codepi.terminalShortcut";

// ── Pure helpers (unit-tested) ───────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The shell script that launches a new CodePi session. `cli` is the resolved
 * code CLI (absolute path or bare `code`); args are forwarded (harmless).
 */
export function buildCodepiShimScript(
	cli: string,
	platform: NodeJS.Platform = process.platform,
): string {
	if (platform === "win32") {
		return `@echo off\r\n"${cli}" --command codepi.newSession %*\r\n`;
	}
	return `#!/bin/sh\nexec "${cli}" --command codepi.newSession "$@"\n`;
}

/**
 * Resolve the code CLI path from the app root: the CLI shim ships inside the
 * app bundle at `<appRoot>/bin/code` (macOS/Linux; stable and Insiders alike).
 * Returns undefined when no such file exists, so callers fall back to `code`
 * on PATH.
 */
export function resolveCodeCliPath(appRoot: string): string | undefined {
	if (!appRoot) return undefined;
	const candidate = join(appRoot, "bin", "code");
	try {
		return fs.existsSync(candidate) ? candidate : undefined;
	} catch {
		return undefined;
	}
}

/**
 * One-line shell command that prepends `binDir` to PATH. Shell family is
 * detected from the shell executable name (vscode.env.shell). Returns
 * undefined for unknown shells (no injection).
 */
export function exportPathCommand(
	shell: string | undefined,
	binDir: string,
): string | undefined {
	const s = (shell ?? "").toLowerCase();
	if (s.includes("fish")) {
		return `set -gx PATH "${binDir}" $PATH`;
	}
	if (s.includes("cmd")) {
		return `set "PATH=${binDir};%PATH%"`;
	}
	if (s.includes("pwsh") || s.includes("powershell")) {
		return `$env:PATH = "${binDir};" + $env:PATH`;
	}
	if (s.includes("bash") || s.includes("zsh") || s.includes("/sh")) {
		return `export PATH="${binDir}:$PATH"`;
	}
	return undefined;
}

/** `codepi.terminalShortcut` from agent settings.json (default: enabled). */
export function readTerminalShortcutEnabled(settings: unknown): boolean {
	const codepi =
		isRecord(settings) && isRecord(settings.codepi) ? settings.codepi : undefined;
	return codepi !== undefined &&
		typeof codepi.terminalShortcut === "boolean"
		? codepi.terminalShortcut
		: true;
}

/** Write the `codepi` launcher executable (dirs created; mode 0755 on POSIX). */
export function writeCodepiShim(
	binPath: string,
	cli: string | undefined,
	platform: NodeJS.Platform = process.platform,
): void {
	fs.mkdirSync(dirname(binPath), { recursive: true });
	fs.writeFileSync(
		binPath,
		buildCodepiShimScript(cli ?? "code", platform),
		platform === "win32" ? undefined : { mode: 0o755 },
	);
}

// ── Installer ────────────────────────────────────────────────

/** Injectable surface of the vscode APIs the installer touches (for tests). */
export interface TerminalShortcutDeps {
	appRoot: string;
	globalStorageUri: vscode.Uri;
	isEnabled: () => boolean;
	readShell: () => string | undefined;
	onDidChangeTerminalShellIntegration: (
		listener: (e: vscode.TerminalShellIntegrationChangeEvent) => void,
	) => vscode.Disposable;
	getOpenTerminals: () => readonly vscode.Terminal[];
	sendText: (terminal: vscode.Terminal, text: string) => void;
}

export interface TerminalShortcutDisposable {
	dispose(): void;
}

/**
 * Install the `codepi` session launcher: write the shim into extension
 * storage, then inject the PATH entry into each integrated terminal once shell
 * integration is ready (including terminals already open at install time).
 */
export function installCodepiTerminalShortcut(
	deps: TerminalShortcutDeps,
): TerminalShortcutDisposable {
	const binDir = join(deps.globalStorageUri.fsPath, BIN_DIR_NAME);
	const binPath = join(binDir, process.platform === "win32" ? "codepi.cmd" : "codepi");
	try {
		writeCodepiShim(binPath, resolveCodeCliPath(deps.appRoot));
	} catch {
		// Read-only storage or fs failure — skip injection rather than crash.
	}

	const injected = new WeakSet<vscode.Terminal>();
	const inject = (terminal: vscode.Terminal | undefined): void => {
		if (!terminal || injected.has(terminal) || !deps.isEnabled()) return;
		const command = exportPathCommand(deps.readShell(), binDir);
		if (!command) return; // unknown shell family — leave the terminal alone
		injected.add(terminal);
		deps.sendText(terminal, command);
	};

	// Terminals already open (and integrated) before this installed.
	for (const terminal of deps.getOpenTerminals()) {
		if (terminal.shellIntegration) inject(terminal);
	}

	const sub = deps.onDidChangeTerminalShellIntegration((e) => {
		if (e.shellIntegration) inject(e.terminal);
	});

	return { dispose: () => sub.dispose() };
}
