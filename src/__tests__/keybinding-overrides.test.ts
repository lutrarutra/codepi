import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
// Exported from the package root as a type only; use the implementation file.
import { KeybindingsManager } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import {
	applyKeybindingOverrides,
	CODEPI_KEYBINDING_OVERRIDES,
} from "../tui/keybinding-overrides";

describe("pi keybinding overrides for CodePi sessions", () => {
	it("unbinds suspend and exit on a real KeybindingsManager", () => {
		const keybindings = new KeybindingsManager({ "app.model.select": ["ctrl+k"] });
		expect(keybindings.getKeys("app.exit")).toContain("ctrl+d");
		expect(applyKeybindingOverrides({ keybindings })).toBe(true);
		expect(keybindings.getKeys("app.suspend")).toEqual([]);
		expect(keybindings.getKeys("app.exit")).toEqual([]);
		expect(keybindings.getKeys("app.clear")).toEqual([]);
		// The user's own bindings survive.
		expect(keybindings.getKeys("app.model.select")).toEqual(["ctrl+k"]);
	});

	it("re-applies the overrides when pi reloads the user's bindings", () => {
		const keybindings = new KeybindingsManager({});
		applyKeybindingOverrides({ keybindings });
		// /reload calls setUserBindings() with the file's contents.
		keybindings.setUserBindings({ "app.suspend": ["ctrl+z"] });
		expect(keybindings.getKeys("app.suspend")).toEqual([]);
	});

	it("reports an InteractiveMode without keybindings", () => {
		expect(applyKeybindingOverrides({})).toBe(false);
		expect(applyKeybindingOverrides(undefined)).toBe(false);
	});

	it("covers only actions pi still defines", () => {
		const keybindings = new KeybindingsManager({});
		for (const id of Object.keys(CODEPI_KEYBINDING_OVERRIDES)) {
			expect(() => keybindings.getDefinition(id as never)).not.toThrow();
			expect(keybindings.getDefinition(id as never)).toBeTruthy();
		}
	});

	it("upstream contract: InteractiveMode keeps its KeybindingsManager on `this.keybindings`", () => {
		const js = fs.readFileSync(
			path.resolve(process.cwd(), "node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js"),
			"utf8",
		);
		expect(js).toMatch(/this\.keybindings = KeybindingsManager\.create\(\);/);
		// Reload re-reads the file through setUserBindings (via reload()).
		expect(js).toMatch(/this\.keybindings\.reload\(\)/);
	});
});
