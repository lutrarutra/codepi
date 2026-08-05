/**
 * Unit tests for src/codepi-terminal-shortcut.ts — the `codepi` session
 * launcher injected into VS Code integrated terminals.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	BIN_DIR_NAME,
	buildCodepiShimScript,
	exportPathCommand,
	installCodepiTerminalShortcut,
	readTerminalShortcutEnabled,
	resolveCodeCliPath,
	writeCodepiShim,
} from "../codepi-terminal-shortcut";

const BIN_PATH = join(tmpdir(), "codepi-shortcut-test-" + process.pid);

function fakeUri(fsPath: string) {
	return { fsPath } as unknown as import("vscode").Uri;
}

describe("buildCodepiShimScript", () => {
	it("execs the resolved CLI with the newSession command", () => {
		const script = buildCodepiShimScript("/Applications/VS Code.app/Contents/Resources/app/bin/code", "darwin");
		expect(script).toContain('exec "/Applications/VS Code.app/Contents/Resources/app/bin/code" --command codepi.newSession "$@"');
		expect(script.startsWith("#!/bin/sh\n")).toBe(true);
	});

	it("falls back to `code` on PATH when no app-root CLI was resolved", () => {
		const script = buildCodepiShimScript("code", "linux");
		expect(script).toContain('exec "code" --command codepi.newSession "$@"');
	});

	it("emits a cmd wrapper on Windows", () => {
		const script = buildCodepiShimScript("C:\\code.cmd", "win32");
		expect(script).toContain('--command codepi.newSession %*');
		expect(script.startsWith("@echo off")).toBe(true);
	});
});

describe("resolveCodeCliPath", () => {
	it("returns <appRoot>/bin/code when it exists", () => {
		const dir = mkdtempSync(join(tmpdir(), "codepi-cli-"));
		const appRoot = join(dir, "app");
		const cli = join(appRoot, "bin", "code");
		// writeCodeShim not needed — just the file
		const { writeFileSync, mkdirSync } = require("node:fs");
		mkdirSync(join(appRoot, "bin"), { recursive: true });
		writeFileSync(cli, "#!/bin/sh\n");
		try {
			expect(resolveCodeCliPath(appRoot)).toBe(cli);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns undefined when absent or appRoot is empty", () => {
		expect(resolveCodeCliPath("")).toBeUndefined();
		const dir = mkdtempSync(join(tmpdir(), "codepi-cli-"));
		try {
			expect(resolveCodeCliPath(dir)).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("exportPathCommand", () => {
	it("uses POSIX export for bash/zsh/sh", () => {
		for (const shell of ["/bin/bash", "/bin/zsh", "/bin/sh"]) {
			expect(exportPathCommand(shell, "/x y/codepi-bin")).toBe('export PATH="/x y/codepi-bin:$PATH"');
		}
	});

	it("uses fish's set -gx", () => {
		expect(exportPathCommand("/opt/homebrew/bin/fish", "/x/codepi-bin")).toBe(
			'set -gx PATH "/x/codepi-bin" $PATH',
		);
	});

	it("uses $env:PATH for pwsh/powershell", () => {
		expect(exportPathCommand("pwsh", "C:\\codepi-bin")).toBe(
			'$env:PATH = "C:\\codepi-bin;" + $env:PATH',
		);
	});

	it("uses set for cmd.exe", () => {
		expect(exportPathCommand("cmd.exe", "C:\\codepi-bin")).toBe(
			'set "PATH=C:\\codepi-bin;%PATH%"',
		);
	});

	it("skips unknown shells", () => {
		expect(exportPathCommand(undefined, "/x")).toBeUndefined();
		expect(exportPathCommand("tcsh", "/x")).toBeUndefined();
	});
});

describe("readTerminalShortcutEnabled", () => {
	it("defaults to enabled", () => {
		expect(readTerminalShortcutEnabled(undefined)).toBe(true);
		expect(readTerminalShortcutEnabled({})).toBe(true);
		expect(readTerminalShortcutEnabled({ codepi: {} })).toBe(true);
	});

	it("honors an explicit false/true", () => {
		expect(readTerminalShortcutEnabled({ codepi: { terminalShortcut: false } })).toBe(false);
		expect(readTerminalShortcutEnabled({ codepi: { terminalShortcut: true } })).toBe(true);
	});

	it("ignores non-boolean values", () => {
		expect(readTerminalShortcutEnabled({ codepi: { terminalShortcut: "yes" } })).toBe(true);
	});
});

describe("writeCodepiShim", () => {
	it("writes an executable shim and its parent dirs", () => {
		const dir = mkdtempSync(join(tmpdir(), "codepi-shim-"));
		const binPath = join(dir, "sub", "codepi");
		try {
			writeCodepiShim(binPath, "/resolved/code", "darwin");
			expect(existsSync(binPath)).toBe(true);
			expect(readFileSync(binPath, "utf8")).toContain("codepi.newSession");
			expect(statSync(binPath).mode & 0o111).not.toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("falls back to `code` on PATH when no cli was resolved", () => {
		const dir = mkdtempSync(join(tmpdir(), "codepi-shim-"));
		try {
			writeCodepiShim(join(dir, "codepi"), undefined, "linux");
			expect(readFileSync(join(dir, "codepi"), "utf8")).toContain('exec "code"');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("installCodepiTerminalShortcut", () => {
	interface FakeTerminal {
		shellIntegration?: object;
		sent: string[];
	}

	function makeTerminal(integrated = false): FakeTerminal {
		return { shellIntegration: integrated ? {} : undefined, sent: [] };
	}

	it("injects the PATH entry once per integrated terminal, gated by the setting", () => {
		const dir = mkdtempSync(join(tmpdir(), "codepi-install-"));
		const terminals: FakeTerminal[] = [makeTerminal(true), makeTerminal(true)];
		const listener = vi.fn();
		const installed = installCodepiTerminalShortcut({
			appRoot: "/unused",
			globalStorageUri: fakeUri(dir),
			isEnabled: () => false, // disabled — nothing injected
			readShell: () => "/bin/zsh",
			onDidChangeTerminalShellIntegration: (l) => {
				listener.mockImplementation(l);
				return { dispose: () => undefined };
			},
			getOpenTerminals: () => terminals as unknown as readonly import("vscode").Terminal[],
			sendText: (t, text) => {
				(t as unknown as FakeTerminal).sent.push(text);
			},
		});

		expect(terminals.every((t) => t.sent.length === 0)).toBe(true);
		installed.dispose();
		rmSync(dir, { recursive: true, force: true });
	});

	it("injects once per terminal and fires for terminals that integrate later", () => {
		const dir = mkdtempSync(join(tmpdir(), "codepi-install-"));
		const open = makeTerminal(false); // already open but not yet integrated
		const terminals = [open];
		const later = makeTerminal(true);
		let listener: (e: { terminal: import("vscode").Terminal; shellIntegration: object }) => void = () => undefined;
		const installed = installCodepiTerminalShortcut({
			appRoot: "/unused",
			globalStorageUri: fakeUri(dir),
			isEnabled: () => true,
			readShell: () => "/bin/zsh",
			onDidChangeTerminalShellIntegration: (l) => {
				listener = l as never;
				return { dispose: () => undefined };
			},
			getOpenTerminals: () => terminals as unknown as readonly import("vscode").Terminal[],
			sendText: (t, text) => {
				(t as unknown as FakeTerminal).sent.push(text);
			},
		});

		// Not integrated at install → nothing yet.
		expect(open.sent).toEqual([]);
		// Integration arrives later → injected.
		listener({ terminal: open as unknown as import("vscode").Terminal, shellIntegration: {} });
		expect(open.sent).toHaveLength(1);
		expect(open.sent[0]).toContain("export PATH=");
		expect(open.sent[0]).toContain(BIN_DIR_NAME);
		// A second integration event does not re-inject.
		listener({ terminal: open as unknown as import("vscode").Terminal, shellIntegration: {} });
		expect(open.sent).toHaveLength(1);
		// A different terminal integrating later also gets it.
		listener({ terminal: later as unknown as import("vscode").Terminal, shellIntegration: {} });
		expect(later.sent).toHaveLength(1);
		installed.dispose();
		rmSync(dir, { recursive: true, force: true });
	});

	it("writes the shim into global storage and skips unknown shells", () => {
		const dir = mkdtempSync(join(tmpdir(), "codepi-install-"));
		const open = makeTerminal(true);
		const installed = installCodepiTerminalShortcut({
			appRoot: "/unused",
			globalStorageUri: fakeUri(dir),
			isEnabled: () => true,
			readShell: () => "tcsh", // unknown → no injection
			onDidChangeTerminalShellIntegration: () => ({ dispose: () => undefined }),
			getOpenTerminals: () => [open] as unknown as readonly import("vscode").Terminal[],
			sendText: (t, text) => {
				(t as unknown as FakeTerminal).sent.push(text);
			},
		});
		try {
			expect(open.sent).toEqual([]);
			expect(existsSync(join(dir, BIN_DIR_NAME, "codepi"))).toBe(true);
		} finally {
			installed.dispose();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
