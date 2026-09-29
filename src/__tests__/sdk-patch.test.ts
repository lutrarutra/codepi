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

describe("SDK host-integration patch (0.87.1)", () => {
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

	describe("SDK baseToolsOverride exposure patch (0.87.1)", () => {
		it("passes baseToolsOverride through createAgentSession", () => {
			const js = fs.readFileSync(path.join(CORE_DIR, "sdk.js"), "utf8");
			expect(js).toMatch(/baseToolsOverride: options\.baseToolsOverride/);
		});
		it("derives the default active tool set from the override keys", () => {
			const js = fs.readFileSync(path.join(CORE_DIR, "sdk.js"), "utf8");
			expect(js).toMatch(
				/defaultActiveToolNames = options\.baseToolsOverride\n\s*\? Object\.keys\(options\.baseToolsOverride\)/,
			);
		});
		it("declares baseToolsOverride on CreateAgentSessionOptions", () => {
			const dts = fs.readFileSync(path.join(CORE_DIR, "sdk.d.ts"), "utf8");
			expect(dts).toMatch(/baseToolsOverride\?: Record<string, Tool>/);
		});
		it("imports the Tool type used by the option", () => {
			// 0.87.1 still re-exports Tool but does not bind it locally, so the
			// patch must add the import itself (skipLibCheck would hide the
			// dangling reference — assert the import explicitly).
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

describe("SDK patch scope (0.87.1)", () => {
	// The patch exists only for what upstream still lacks: the baseToolsOverride
	// exposure and the CJS `require` export condition. 0.87.0 adopted the
	// interactive-mode `terminal` option, so a leftover hunk for that file would
	// fail to apply on the next bump — guard the patch's scope, not just the
	// installed tree.
	const PATCH_DIR = path.resolve(process.cwd(), "patches");

	function piPatches(): string[] {
		return fs
			.readdirSync(PATCH_DIR)
			.filter((file) => file.endsWith(".patch"));
	}

	it("ships exactly one patch, for the pinned pi version", () => {
		expect(piPatches()).toEqual([
			"@earendil-works+pi-coding-agent+0.87.1.patch",
		]);
	});

	it("does not patch interactive-mode (native since 0.87.0)", () => {
		for (const file of piPatches()) {
			const text = fs.readFileSync(path.join(PATCH_DIR, file), "utf8");
			expect(text).not.toMatch(/dist\/modes\/interactive\//);
		}
	});

	it("still patches the baseToolsOverride exposure and the CJS export map", () => {
		const text = fs.readFileSync(
			path.join(PATCH_DIR, piPatches()[0]),
			"utf8",
		);
		expect(text).toMatch(/baseToolsOverride/);
		expect(text).toMatch(/promptSnippet: tool\.promptSnippet/);
		expect(text).toMatch(/"require": "\.\/dist\/index\.js"/);
	});
});
