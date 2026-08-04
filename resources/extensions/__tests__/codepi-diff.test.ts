import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import codepiDiff from "../codepi-diff";

type Handler = (event: any, ctx: any) => unknown;

function createMockPi() {
	const handlers = new Map<string, Handler[]>();
	const entries: Array<{ customType: string; data: any }> = [];
	const api = {
		on(event: string, handler: Handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerCommand: () => {},
		appendEntry(customType: string, data: any) {
			entries.push({ customType, data });
		},
	};
	return { api, handlers, entries };
}

// Passthrough theme: color/bold markers are dropped, text content survives.
const mockTheme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

function makeCtx(cwd: string) {
	const statuses: Array<[string, string | undefined]> = [];
	const widgets: Array<[string, string[] | undefined]> = [];
	const ctx = {
		cwd,
		hasUI: true,
		ui: {
			theme: mockTheme,
			setStatus: (key: string, text: string | undefined) =>
				statuses.push([key, text]),
			setWidget: (key: string, content: string[] | undefined) =>
				widgets.push([key, content]),
		},
		sessionManager: { getBranch: () => [] },
	};
	return { ctx, statuses, widgets };
}

describe("codepi-diff: cwd scoping", () => {
	let dir: string;
	let outsideFile: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "codepi-diff-"));
		outsideFile = join(tmpdir(), `codepi-diff-outside-${Date.now()}.ts`);
		writeFileSync(outsideFile, "one\n");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		rmSync(outsideFile, { force: true });
	});

	it("ignores edit/write calls to files outside the cwd", async () => {
		const mock = createMockPi();
		codepiDiff(mock.api as any);
		const { ctx, statuses } = makeCtx(dir);

		const call = mock.handlers.get("tool_call")![0];
		await call(
			{
				type: "tool_call",
				toolName: "edit",
				toolCallId: "c1",
				input: { path: outsideFile },
			},
			ctx,
		);
		writeFileSync(outsideFile, "two\n");
		const res = mock.handlers.get("tool_result")![0];
		await res(
			{
				type: "tool_result",
				toolName: "edit",
				toolCallId: "c1",
				isError: false,
			},
			ctx,
		);

		expect(
			mock.entries.filter((e) => e.customType === "filechanges:baseline"),
		).toHaveLength(0);
		expect(statuses).toHaveLength(0);
	});

	it("tracks edit/write calls to files inside the cwd", async () => {
		const mock = createMockPi();
		codepiDiff(mock.api as any);
		const { ctx, statuses, widgets } = makeCtx(dir);
		const inFile = join(dir, "a.ts");
		writeFileSync(inFile, "one\n");

		const call = mock.handlers.get("tool_call")![0];
		await call(
			{
				type: "tool_call",
				toolName: "edit",
				toolCallId: "c2",
				input: { path: "a.ts" },
			},
			ctx,
		);
		writeFileSync(inFile, "two\n");
		const res = mock.handlers.get("tool_result")![0];
		await res(
			{
				type: "tool_result",
				toolName: "edit",
				toolCallId: "c2",
				isError: false,
			},
			ctx,
		);

		const baselines = mock.entries.filter(
			(e) => e.customType === "filechanges:baseline",
		);
		expect(baselines).toHaveLength(1);
		expect(baselines[0].data.path).toBe("a.ts");
		expect(baselines[0].data.originalContent).toBe("one\n");
		expect(statuses).toContainEqual(["filechanges", "Δ 1  + 0"]);
		expect(widgets.length).toBeGreaterThan(0);
	});

	it("skips out-of-cwd baselines when rebuilding from session entries", async () => {
		const mock = createMockPi();
		codepiDiff(mock.api as any);
		const { ctx, statuses } = makeCtx(dir);
		const branch = [
			{
				id: "e1",
				type: "custom",
				customType: "filechanges:baseline",
				data: {
					path: outsideFile,
					originalContent: "one\n",
					timestamp: Date.now(),
				},
			},
		];
		const sessionStart = mock.handlers.get("session_start")![0];
		await sessionStart(
			{ type: "session_start", reason: "startup" },
			{ ...ctx, sessionManager: { getBranch: () => branch } },
		);

		// Nothing tracked → status is cleared, no "Δ" summary appears.
		expect(statuses).toEqual([["filechanges", undefined]]);

		// Stop the reconcile timer so the test process can exit.
		const shutdown = mock.handlers.get("session_shutdown")![0];
		await shutdown({ type: "session_shutdown" }, ctx);
	});

	it("lists tracked files alphabetically so re-renders are stable", async () => {
		const mock = createMockPi();
		codepiDiff(mock.api as any);
		const { ctx, widgets } = makeCtx(dir);
		const bFile = join(dir, "b.ts");
		const aFile = join(dir, "a.ts");
		writeFileSync(bFile, "one\n");
		writeFileSync(aFile, "one\n");

		const call = mock.handlers.get("tool_call")![0];
		const res = mock.handlers.get("tool_result")![0];
		// Track b.ts first, then a.ts (later updatedAt).
		await call(
			{
				type: "tool_call",
				toolName: "edit",
				toolCallId: "c1",
				input: { path: "b.ts" },
			},
			ctx,
		);
		writeFileSync(bFile, "two\n");
		await res(
			{
				type: "tool_result",
				toolName: "edit",
				toolCallId: "c1",
				isError: false,
			},
			ctx,
		);
		await call(
			{
				type: "tool_call",
				toolName: "edit",
				toolCallId: "c2",
				input: { path: "a.ts" },
			},
			ctx,
		);
		writeFileSync(aFile, "two\n");
		await res(
			{
				type: "tool_result",
				toolName: "edit",
				toolCallId: "c2",
				isError: false,
			},
			ctx,
		);

		const lines = widgets[widgets.length - 1][1] ?? [];
		const aIdx = lines.findIndex((l) => l.startsWith("Δ a.ts"));
		const bIdx = lines.findIndex((l) => l.startsWith("Δ b.ts"));
		expect(aIdx).toBeGreaterThanOrEqual(0);
		expect(bIdx).toBeGreaterThan(aIdx);
	});

	describe("diff stat formatting", () => {
		async function trackFile(
			mock: any,
			ctx: any,
			rel: string,
			before: string,
			after: string,
		) {
			const abs = join(ctx.cwd, rel);
			const toolCallId = `c-${rel}-${Date.now()}-${Math.random()}`;
			writeFileSync(abs, before);
			const call = mock.handlers.get("tool_call")![0];
			await call(
				{
					type: "tool_call",
					toolName: "edit",
					toolCallId,
					input: { path: rel },
				},
				ctx,
			);
			writeFileSync(abs, after);
			const res = mock.handlers.get("tool_result")![0];
			await res(
				{
					type: "tool_result",
					toolName: "edit",
					toolCallId,
					isError: false,
				},
				ctx,
			);
		}

		it("omits -0 when a file only gained lines", async () => {
			const mock = createMockPi();
			codepiDiff(mock.api as any);
			const { ctx, widgets } = makeCtx(dir);
			await trackFile(mock, ctx, "a.ts", "one\n", "one\ntwo\n");

			const lines = widgets[widgets.length - 1][1] ?? [];
			const line = lines.find((l) => l.startsWith("Δ a.ts"));
			expect(line).toContain("(+1)");
			expect(line).not.toContain("-0");
		});

		it("omits +0 when a file only lost lines", async () => {
			const mock = createMockPi();
			codepiDiff(mock.api as any);
			const { ctx, widgets } = makeCtx(dir);
			await trackFile(mock, ctx, "a.ts", "one\ntwo\nthree\n", "two\n");

			const lines = widgets[widgets.length - 1][1] ?? [];
			const line = lines.find((l) => l.startsWith("Δ a.ts"));
			expect(line).toContain("(-2)");
			expect(line).not.toContain("+0");
		});

		it("keeps both parts when a file gained and lost lines", async () => {
			const mock = createMockPi();
			codepiDiff(mock.api as any);
			const { ctx, widgets } = makeCtx(dir);
			await trackFile(mock, ctx, "a.ts", "one\n", "two\nthree\n");

			const lines = widgets[widgets.length - 1][1] ?? [];
			const line = lines.find((l) => l.startsWith("Δ a.ts"));
			expect(line).toContain("(+2/-1)");
		});
	});
});
