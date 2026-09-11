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

describe("SDK host-integration patch (0.85.1)", () => {
	it("threads options.terminal into createInteractiveTui", () => {
		const js = fs.readFileSync(
			path.join(DIST_DIR, "interactive-mode.js"),
			"utf8",
		);
		// The `?? new ProcessTerminal()` fallback exists upstream inside
		// createInteractiveTui since 0.84.0; the patch only threads the option
		// from InteractiveModeOptions into that call. Upstream keeps adding
		// properties to the same call (0.84.1 `onRightClickPaste`, 0.85.1
		// `fullscreenCopyOnSelect`), so allow any trailing property lines.
		expect(js).toMatch(
			/createInteractiveTui\(\{[\s\S]*?\n\s*terminal: options\.terminal,\n(?:\s*\w+: [^\n]*,\n)*\s*\}\)/,
		);
	});
	it("declares terminal on InteractiveModeOptions", () => {
		const dts = fs.readFileSync(
			path.join(DIST_DIR, "interactive-mode.d.ts"),
			"utf8",
		);
		// Upstream also declares `terminal?:` (on InteractiveTuiOptions),
		// so assert the option sits inside InteractiveModeOptions, next to tuiMode.
		expect(dts).toMatch(
			/tuiMode\?: TuiMode;\n {4}\/\*\* Custom terminal[^\n]*\*\/\n {4}terminal\?: import\("@earendil-works\/pi-tui"\)\.Terminal;/,
		);
	});

	describe("SDK baseToolsOverride exposure patch (0.85.1)", () => {
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
			// 0.85.1 re-exports Tool but does not bind it locally, so the
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
