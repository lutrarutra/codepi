import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import { HOST_CLIPBOARD_KEY, installHostClipboard } from "../host-clipboard";

let dispose: (() => void) | undefined;
afterEach(() => {
	dispose?.();
	dispose = undefined;
});

describe("host clipboard for pi's /copy", () => {
	it("pi's copyToClipboard (patched) hands the text to the host", async () => {
		const writeText = vi.fn();
		dispose = installHostClipboard(writeText);
		await copyToClipboard("the last answer");
		expect(writeText).toHaveBeenCalledWith("the last answer");
	});

	it("propagates a host clipboard failure to pi (pi reports it)", async () => {
		dispose = installHostClipboard(() => Promise.reject(new Error("no clipboard")));
		await expect(copyToClipboard("x")).rejects.toThrow("no clipboard");
	});

	it("dispose removes the hook (only its own)", () => {
		const target: Record<string, unknown> = {};
		const off = installHostClipboard(vi.fn(), target);
		expect(typeof target[HOST_CLIPBOARD_KEY]).toBe("function");
		off();
		expect(target[HOST_CLIPBOARD_KEY]).toBeUndefined();
	});

	it("the patch keeps the hook first in copyToClipboard", () => {
		const js = fs.readFileSync("node_modules/@earendil-works/pi-coding-agent/dist/utils/clipboard.js", "utf8");
		expect(js).toMatch(/export async function copyToClipboard\(text\) \{\s*\/\/[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*const hostWrite = globalThis\.__piHostClipboardWrite;/);
	});
});
