import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const DIST_DIR = path.resolve(
	process.cwd(),
	"node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive",
);

describe("SDK terminal-injection patch (0.83.0)", () => {
	it("threads options.terminal into the TUI constructor", () => {
		const js = fs.readFileSync(path.join(DIST_DIR, "interactive-mode.js"), "utf8");
		expect(js).toMatch(/options\.terminal \?\? new ProcessTerminal\(\)/);
	});
	it("declares terminal on InteractiveModeOptions", () => {
		const dts = fs.readFileSync(path.join(DIST_DIR, "interactive-mode.d.ts"), "utf8");
		expect(dts).toMatch(/terminal\?:/);
		expect(dts).toMatch(/@earendil-works\/pi-tui/);
	});
});
