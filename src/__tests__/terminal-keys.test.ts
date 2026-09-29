import { describe, expect, it } from "vitest";
import {
	LINE_END_INPUT,
	LINE_START_INPUT,
	type ArrowChordEvent,
	resolveArrowChord,
} from "../tui/terminal-keys";

/** Build an ArrowChordEvent with everything released unless overridden. */
function ev(overrides: Partial<ArrowChordEvent> = {}): ArrowChordEvent {
	return {
		key: "ArrowLeft",
		ctrlKey: false,
		metaKey: false,
		altKey: false,
		shiftKey: false,
		...overrides,
	};
}

describe("resolveArrowChord", () => {
	it("lets unmodified arrows fall through to xterm", () => {
		for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) {
			expect(resolveArrowChord(ev({ key }))).toBeUndefined();
		}
	});

	it("lets Ctrl+Left/Right fall through so pi moves by a word", () => {
		// Regression guard for issue #4: intercepting these turned Windows
		// Ctrl+Left/Right into line start/end instead of word navigation.
		expect(resolveArrowChord(ev({ key: "ArrowLeft", ctrlKey: true }))).toBeUndefined();
		expect(resolveArrowChord(ev({ key: "ArrowRight", ctrlKey: true }))).toBeUndefined();
	});

	it("maps Cmd+Left/Right to line start/end (macOS text-field chords)", () => {
		expect(resolveArrowChord(ev({ key: "ArrowLeft", metaKey: true }))).toBe(
			LINE_START_INPUT,
		);
		expect(resolveArrowChord(ev({ key: "ArrowRight", metaKey: true }))).toBe(
			LINE_END_INPUT,
		);
	});

	it("does not treat Ctrl+Cmd+Left/Right as the macOS chord", () => {
		expect(
			resolveArrowChord(ev({ key: "ArrowLeft", ctrlKey: true, metaKey: true })),
		).toBeUndefined();
		expect(
			resolveArrowChord(ev({ key: "ArrowRight", ctrlKey: true, metaKey: true })),
		).toBeUndefined();
	});

	it("maps Ctrl/Cmd+Up/Down to line start/end (unbound in pi)", () => {
		for (const metaKey of [false, true]) {
			expect(resolveArrowChord(ev({ key: "ArrowUp", ctrlKey: true, metaKey }))).toBe(
				LINE_START_INPUT,
			);
			expect(
				resolveArrowChord(ev({ key: "ArrowDown", ctrlKey: true, metaKey })),
			).toBe(LINE_END_INPUT);
		}
	});

	it("never touches Shift or Alt variants (selection / host handling)", () => {
		expect(
			resolveArrowChord(ev({ key: "ArrowLeft", ctrlKey: true, shiftKey: true })),
		).toBeUndefined();
		expect(
			resolveArrowChord(ev({ key: "ArrowLeft", metaKey: true, shiftKey: true })),
		).toBeUndefined();
		expect(
			resolveArrowChord(ev({ key: "ArrowLeft", ctrlKey: true, altKey: true })),
		).toBeUndefined();
		expect(
			resolveArrowChord(ev({ key: "ArrowUp", metaKey: true, altKey: true })),
		).toBeUndefined();
	});

	it("ignores non-arrow keys", () => {
		expect(resolveArrowChord(ev({ key: "Backspace", ctrlKey: true }))).toBeUndefined();
		expect(resolveArrowChord(ev({ key: "a", metaKey: true }))).toBeUndefined();
		expect(resolveArrowChord(ev({ key: "Home", ctrlKey: true }))).toBeUndefined();
	});
});
