import { describe, expect, it } from "vitest";
import {
	classifyAsUrl,
	escapeGlob,
	normalizeSearchText,
	splitLineColumn,
} from "../tui/links";

describe("classifyAsUrl", () => {
	it("classifies scheme:// words as URLs", () => {
		expect(classifyAsUrl("https://example.com/x")).toEqual({ scheme: "https" });
		expect(classifyAsUrl("http://example.com")).toEqual({ scheme: "http" });
		expect(classifyAsUrl("ftp://files.example.com")).toEqual({ scheme: "ftp" });
		expect(classifyAsUrl("ssh://git@github.com/repo")).toEqual({
			scheme: "ssh",
		});
		expect(classifyAsUrl("file:///home/user/x.ts")).toEqual({ scheme: "file" });
	});

	it("classifies mailto", () => {
		expect(classifyAsUrl("mailto:user@example.com")).toEqual({
			scheme: "mailto",
		});
	});

	it("does not classify plain words or Windows drive paths", () => {
		expect(classifyAsUrl("hello")).toBeUndefined();
		expect(classifyAsUrl("C:\\Users\\artur\\x.ts")).toBeUndefined();
		expect(classifyAsUrl("src/foo.ts:12")).toBeUndefined();
	});
});

describe("splitLineColumn", () => {
	it("splits :line and :line:col suffixes", () => {
		expect(splitLineColumn("src/foo.ts")).toEqual({ path: "src/foo.ts" });
		expect(splitLineColumn("src/foo.ts:12")).toEqual({
			path: "src/foo.ts",
			line: 12,
		});
		expect(splitLineColumn("src/foo.ts:12:5")).toEqual({
			path: "src/foo.ts",
			line: 12,
			column: 5,
		});
	});

	it("keeps the whole word when there is no numeric suffix", () => {
		expect(splitLineColumn("foo:bar")).toEqual({ path: "foo:bar" });
		expect(splitLineColumn("12")).toEqual({ path: "12" });
		expect(splitLineColumn("C:\\foo\\bar")).toEqual({ path: "C:\\foo\\bar" });
	});
});

describe("normalizeSearchText", () => {
	it("strips a file:// prefix", () => {
		expect(normalizeSearchText("file:///home/user/x.ts")).toBe(
			"/home/user/x.ts",
		);
	});

	it("strips a trailing :<non-number> tail", () => {
		expect(normalizeSearchText("foo.rb:in")).toBe("foo.rb");
	});

	it("strips a trailing period", () => {
		expect(normalizeSearchText("src/foo.ts.")).toBe("src/foo.ts");
	});

	it("keeps numeric suffixes intact", () => {
		expect(normalizeSearchText("src/foo.ts:12")).toBe("src/foo.ts:12");
	});
});

describe("escapeGlob", () => {
	it("escapes glob metacharacters", () => {
		expect(escapeGlob("foo[1].ts")).toBe("foo\\[1\\].ts");
		expect(escapeGlob("a*b?c{d}")).toBe("a\\*b\\?c\\{d\\}");
		expect(escapeGlob("plain.ts")).toBe("plain.ts");
	});
});
