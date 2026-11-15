import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const DIST_DIR = path.resolve(
	process.cwd(),
	"node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive",
);
const CORE_DIR = path.resolve(
	process.cwd(),
	"node_modules/@earendil-works/pi-coding-agent/dist/core",
);

describe("SDK host-integration patch (1.5.2)", () => {
	it("threads options.terminal into createInteractiveTui", () => {
		const js = fs.readFileSync(
			path.join(DIST_DIR, "interactive-mode.js"),
			"utf8",
		);
		// CodePi's custom webview pty arrives via options.terminal, and the
		// `?? new ProcessTerminal()` fallback lives inside createInteractiveTui
		// (since 0.84.0). CodePi patched this threading until 0.87.0 adopted it
		// natively, so the assertion now guards the upstream contract instead of
		// the patch. Upstream keeps adding properties to the same call (0.84.1
		// `onRightClickPaste`, 0.85.1 `fullscreenCopyOnSelect`), so allow any
		// trailing property lines.
		expect(js).toMatch(
			/createInteractiveTui\(\{[\s\S]*?\n\s*terminal: options\.terminal,\n(?:\s*\w+: [^\n]*,\n)*\s*\}\)/,
		);
	});
	it("declares terminal on InteractiveModeOptions", () => {
		const dts = fs.readFileSync(
			path.join(DIST_DIR, "interactive-mode.d.ts"),
			"utf8",
		);
		// Native since 0.87.0 (no longer patch-provided). Upstream also declares
		// `terminal?:` on InteractiveTuiOptions, so anchor on the
		// initialThemeSetting neighbour to pin the InteractiveModeOptions copy.
		expect(dts).toMatch(
			/initialThemeSetting\?: string;\n {4}\/\*\* Terminal implementation[^\n]*\*\/\n {4}terminal\?: Terminal;/,
		);
	});

	describe("SDK baseToolsOverride exposure patch (1.5.2)", () => {
		it("passes baseToolsOverride through createAgentSession", () => {
			const js = fs.readFileSync(path.join(CORE_DIR, "sdk.js"), "utf8");
			expect(js).toMatch(/baseToolsOverride: options\.baseToolsOverride/);
		});
		it("derives the default active tool set from the override keys", () => {
			// createAgentSession computes the active set (AgentSession's own
			// defaultActiveToolNames derivation is bypassed by the explicit
			// initialActiveToolNames argument), so the patch has to seed it there.
			// Since 1.1.0 `+name`/`-name` tool modifiers apply on top of
			// `defaultToolNames`, so the override keys replace that default rather
			// than the final active set.
			const js = fs.readFileSync(path.join(CORE_DIR, "sdk.js"), "utf8");
			expect(js).toMatch(
				/defaultToolNames = options\.noTools\n\s*\? \[\]\n\s*: options\.baseToolsOverride\n\s*\? Object\.keys\(options\.baseToolsOverride\)/,
			);
		});
		it("declares baseToolsOverride on CreateAgentSessionOptions", () => {
			const dts = fs.readFileSync(path.join(CORE_DIR, "sdk.d.ts"), "utf8");
			expect(dts).toMatch(/baseToolsOverride\?: Record<string, Tool>/);
		});
		it("imports the Tool type used by the option", () => {
			// 1.5.2 re-exports Tool from its package root but does not bind it
			// locally in sdk.d.ts, so the patch must add the import itself
			// (skipLibCheck would hide the dangling reference — assert the import
			// explicitly).
			const dts = fs.readFileSync(path.join(CORE_DIR, "sdk.d.ts"), "utf8");
			expect(dts).toMatch(
				/import type \{ Tool \} from "\.\/tools\/index\.ts";/,
			);
		});
		it("forwards prompt metadata and renderers when synthesizing definitions", () => {
			const js = fs.readFileSync(
				path.join(CORE_DIR, "tools/tool-definition-wrapper.js"),
				"utf8",
			);
			expect(js).toMatch(/promptSnippet: tool\.promptSnippet/);
			expect(js).toMatch(/promptGuidelines: tool\.promptGuidelines/);
			expect(js).toMatch(/renderShell: tool\.renderShell/);
			expect(js).toMatch(/renderCall: tool\.renderCall/);
			expect(js).toMatch(/renderResult: tool\.renderResult/);
		});
	});

	describe("SDK extension-dialog events (moved to the ui_prompt bridge)", () => {
		it("no longer patches dialog events into interactive-mode", () => {
			// Dialog coverage comes from pi's official ui_prompt_start/end
			// extension events via createActivityBridge (src/session-activity.ts),
			// so the patch must not emit anything itself — and must not depend on
			// the private AgentSession._emit that upstream could rename at will.
			const js = fs.readFileSync(
				path.join(DIST_DIR, "interactive-mode.js"),
				"utf8",
			);
			expect(js).not.toMatch(/extension_ui_start|extension_ui_end/);
			expect(js).not.toMatch(/this\.session\?\._emit/);
		});
	});
});

describe("SDK patch scope (1.5.2)", () => {
	// The patch exists only for what upstream still lacks: the baseToolsOverride
	// exposure, the prompt-metadata/renderer pass-through, the CJS `require`
	// export condition, the host clipboard hook, and startup hints that skip
	// unbound keys. The interactive-mode `terminal` option has been native
	// since 0.87.0, so a leftover hunk for it would fail to apply on the next
	// bump — guard the patch's scope, not just the installed tree.
	const PATCH_DIR = path.resolve(process.cwd(), "patches");

	function piPatches(): string[] {
		return fs
			.readdirSync(PATCH_DIR)
			.filter((file) => file.endsWith(".patch"));
	}

	it("ships exactly one patch, for the pinned pi version", () => {
		expect(piPatches()).toEqual([
			"@earendil-works+pi-coding-agent+1.5.2.patch",
		]);
	});

	it("does not patch interactive-mode's terminal option (native since 0.87.0)", () => {
		for (const file of piPatches()) {
			const text = fs.readFileSync(path.join(PATCH_DIR, file), "utf8");
			expect(text).not.toMatch(/options\.terminal \?\? new ProcessTerminal/);
			expect(text).not.toMatch(/^\+\+?\s+terminal\?:/m);
		}
	});

	it("still patches the baseToolsOverride exposure, the CJS export map, the host clipboard hook and the startup hints", () => {
		const text = fs.readFileSync(
			path.join(PATCH_DIR, piPatches()[0]),
			"utf8",
		);
		expect(text).toMatch(/baseToolsOverride/);
		expect(text).toMatch(/promptSnippet: tool\.promptSnippet/);
		expect(text).toMatch(/"require": "\.\/dist\/index\.js"/);
		expect(text).toMatch(/globalThis\.__piHostClipboardWrite/);
		// Startup hints of actions CodePi unbinds are left out.
		expect(text).toMatch(/\+\s+const bound = \(\.\.\.keybindings\) =>/);
	});
});
