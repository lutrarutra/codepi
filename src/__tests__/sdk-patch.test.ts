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

describe("SDK host-integration patch (0.83.0)", () => {
	it("threads options.terminal into the TUI constructor", () => {
		const js = fs.readFileSync(
			path.join(DIST_DIR, "interactive-mode.js"),
			"utf8",
		);
		expect(js).toMatch(/options\.terminal \?\? new ProcessTerminal\(\)/);
	});
	it("declares terminal on InteractiveModeOptions", () => {
		const dts = fs.readFileSync(
			path.join(DIST_DIR, "interactive-mode.d.ts"),
			"utf8",
		);
		expect(dts).toMatch(/terminal\?:/);
		expect(dts).toMatch(/@earendil-works\/pi-tui/);
	});

	describe("SDK baseToolsOverride exposure patch (0.83.0)", () => {
		it("passes baseToolsOverride through createAgentSession", () => {
			const js = fs.readFileSync(
				path.join(CORE_DIR, "sdk.js"),
				"utf8",
			);
			expect(js).toMatch(/baseToolsOverride: options\.baseToolsOverride/);
		});
		it("derives the default active tool set from the override keys", () => {
			const js = fs.readFileSync(
				path.join(CORE_DIR, "sdk.js"),
				"utf8",
			);
			expect(js).toMatch(
				/defaultActiveToolNames = options\.baseToolsOverride\n\s*\? Object\.keys\(options\.baseToolsOverride\)/,
			);
		});
		it("declares baseToolsOverride on CreateAgentSessionOptions", () => {
			const dts = fs.readFileSync(
				path.join(CORE_DIR, "sdk.d.ts"),
				"utf8",
			);
			expect(dts).toMatch(/baseToolsOverride\?: Record<string, Tool>/);
		});
		it("forwards prompt metadata and renderers when synthesizing definitions", () => {
			const js = fs.readFileSync(
				path.join(
					CORE_DIR,
					"tools/tool-definition-wrapper.js",
				),
				"utf8",
			);
			expect(js).toMatch(/promptSnippet: tool\.promptSnippet/);
			expect(js).toMatch(/renderResult: tool\.renderResult/);
		});
	});

	describe("SDK extension-dialog events patch (0.83.0)", () => {
		it("emits extension_ui_start/end for the selector dialog", () => {
			const js = fs.readFileSync(
				path.join(DIST_DIR, "interactive-mode.js"),
				"utf8",
			);
			expect(js).toMatch(
				/extension_ui_start", ui: "select/,
			);
			expect(js).toMatch(/extension_ui_end", ui: "select"/);
		});
		it("emits extension_ui_start/end for the input dialog", () => {
			const js = fs.readFileSync(
				path.join(DIST_DIR, "interactive-mode.js"),
				"utf8",
			);
			expect(js).toMatch(/extension_ui_start", ui: "input"/);
			expect(js).toMatch(/extension_ui_end", ui: "input"/);
		});
	});
});
