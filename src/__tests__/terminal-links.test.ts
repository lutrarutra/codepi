import { describe, expect, it } from "vitest";
import {
	detectWordLinks,
	isActivationModifierDown,
	MAX_LINK_LINE_LENGTH,
	osc8ToCodePiLink,
	type CodePiLink,
} from "../tui/terminal-links";

function texts(
	line: string,
): Array<{ text: string; start: number; end: number }> {
	return detectWordLinks(line).map((l: CodePiLink) => ({
		text: l.text,
		start: l.start,
		end: l.end,
	}));
}

describe("detectWordLinks — every word is a link (VS Code parity)", () => {
	it("splits a sentence into words", () => {
		const words = texts("hello world this is pi");
		expect(words.map((w) => w.text)).toEqual([
			"hello",
			"world",
			"this",
			"is",
			"pi",
		]);
	});

	it("keeps URLs as single words", () => {
		const words = texts("see https://example.com/docs now");
		expect(words[1].text).toBe("https://example.com/docs");
	});

	it("keeps file paths with :line:col as single words", () => {
		const words = texts("edit src/foo.ts:12:5 now");
		expect(words[1].text).toBe("src/foo.ts:12:5");
	});

	it("drops a trailing colon from a word", () => {
		const words = texts("https://example.com:");
		expect(words[0].text).toBe("https://example.com");
		expect(words[0].end).toBe("https://example.com".length);
	});

	it("treats default word separators as boundaries", () => {
		const words = texts("a(b),c\"d\"e'f'`g`h|i");
		// separators: ( ) , " ' ` |
		expect(words.map((w) => w.text)).toEqual([
			"a",
			"b",
			"c",
			"d",
			"e",
			"f",
			"g",
			"h",
			"i",
		]);
	});

	it("computes correct character ranges", () => {
		const words = texts("ab cd");
		expect(words).toEqual([
			{ text: "ab", start: 0, end: 2 },
			{ text: "cd", start: 3, end: 5 },
		]);
	});

	it("handles consecutive separators", () => {
		const words = texts("a  b");
		expect(words.map((w) => w.text)).toEqual(["a", "b"]);
		expect(words[1].start).toBe(3);
	});

	it("handles leading/trailing separators", () => {
		const words = texts(" x ");
		expect(words).toEqual([{ text: "x", start: 1, end: 2 }]);
	});

	it("splits on the powerline symbol range", () => {
		const branch = String.fromCharCode(0xe0b0);
		const words = texts(`left${branch}right`);
		expect(words.map((w) => w.text)).toEqual(["left", "right"]);
	});

	it("skips words longer than the 100-char cap", () => {
		const words = texts("x".repeat(101) + " ok");
		expect(words).toEqual([{ text: "ok", start: 102, end: 104 }]);
	});

	it("returns nothing for empty or over-long lines", () => {
		expect(detectWordLinks("")).toEqual([]);
		expect(detectWordLinks(" ".repeat(10))).toEqual([]);
		expect(detectWordLinks("x".repeat(MAX_LINK_LINE_LENGTH + 10))).toEqual([]);
	});
});

describe("activation modifier", () => {
	it("accepts ctrl, meta and alt", () => {
		expect(
			isActivationModifierDown({
				ctrlKey: true,
				metaKey: false,
				altKey: false,
			}),
		).toBe(true);
		expect(
			isActivationModifierDown({
				ctrlKey: false,
				metaKey: true,
				altKey: false,
			}),
		).toBe(true);
		expect(
			isActivationModifierDown({
				ctrlKey: false,
				metaKey: false,
				altKey: true,
			}),
		).toBe(true);
	});

	it("rejects a plain click", () => {
		expect(
			isActivationModifierDown({
				ctrlKey: false,
				metaKey: false,
				altKey: false,
			}),
		).toBe(false);
	});
});

describe("osc8ToCodePiLink", () => {
	it("maps http URLs", () => {
		expect(osc8ToCodePiLink("https://example.com")).toMatchObject({
			kind: "url",
			url: "https://example.com",
		});
	});

	it("maps file:// targets", () => {
		expect(osc8ToCodePiLink("file:///home/user/x.ts")).toMatchObject({
			kind: "file",
			path: "file:///home/user/x.ts",
		});
	});
});
