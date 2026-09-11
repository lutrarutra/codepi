import { describe, expect, it, vi } from "vitest";
import {
	installInspectorUncaughtGuard,
	isBenignInspectorError,
} from "../uncaught-guard";

/** Real stack shape captured from the VS Code extension host logs. */
const INSPECTOR_STACK = [
	"TypeError: Missing dataLength in event",
	"    at broadcastToFrontend (node:inspector:212:3)",
	"    at Object.dataReceived (node:inspector:221:29)",
	"    at IncomingMessage.<anonymous> (node:internal/inspector/network_http:140:13)",
	"    at IncomingMessage.emit (node:events:521:24)",
	"    at process.processTicksAndRejections (node:internal/process/task_queues:90:21)",
].join("\n");

function inspectorError(
	message = "Missing dataLength in event",
	stack = INSPECTOR_STACK,
): TypeError {
	const error = new TypeError(message);
	error.stack = stack;
	return error;
}

describe("isBenignInspectorError", () => {
	it("matches the inspector network-validation family", () => {
		expect(isBenignInspectorError(inspectorError())).toBe(true);
		expect(
			isBenignInspectorError(inspectorError("Missing requestId in event")),
		).toBe(true);
		expect(
			isBenignInspectorError(
				inspectorError("Request data is not finished yet"),
			),
		).toBe(true);
	});

	it("rejects the same message from elsewhere (no inspector frame)", () => {
		expect(
			isBenignInspectorError(
				inspectorError(
					"Missing dataLength in event",
					"TypeError: Missing dataLength in event\n    at ourOwnCode (/app/dist/extension.js:1:1)",
				),
			),
		).toBe(false);
	});

	it("rejects unrelated errors, non-Errors and missing stacks", () => {
		expect(isBenignInspectorError(new TypeError("boom"))).toBe(false);
		expect(isBenignInspectorError(new Error("Missing data in event"))).toBe(
			false,
		);
		expect(isBenignInspectorError("Missing dataLength in event")).toBe(false);
		expect(isBenignInspectorError(undefined)).toBe(false);
		const noStack = new TypeError("Missing dataLength in event");
		noStack.stack = undefined;
		expect(isBenignInspectorError(noStack)).toBe(false);
	});
});

function makeFakeProcess(listeners: Array<(error: unknown) => void> = []) {
	const state = {
		capture: null as ((error: unknown) => void) | null,
		listeners: [...listeners],
	};
	const proc = {
		listeners: () => state.listeners,
		setUncaughtExceptionCaptureCallback: (
			callback: ((error: unknown) => void) | null,
		) => {
			state.capture = callback;
		},
		hasUncaughtExceptionCaptureCallback: () => state.capture !== null,
	} as unknown as NodeJS.Process;
	return { proc, state };
}

describe("installInspectorUncaughtGuard", () => {
	it("does nothing when the process is not inspectable", () => {
		const { proc, state } = makeFakeProcess();
		const guard = installInspectorUncaughtGuard({
			process: proc,
			getInspectorUrl: () => undefined,
			log: vi.fn(),
		});
		expect(state.capture).toBeNull();
		guard.dispose(); // must not throw either
	});

	it("does not steal an existing capture callback", () => {
		const { proc, state } = makeFakeProcess();
		state.capture = vi.fn();
		installInspectorUncaughtGuard({
			process: proc,
			getInspectorUrl: () => "ws://127.0.0.1:9229/uuid",
			log: vi.fn(),
		});
		expect(state.capture).not.toBe(undefined);
		expect(state.capture).toHaveBeenCalledTimes(0);
	});

	it("swallows the benign inspector error and keeps the session alive", () => {
		const piCrash = vi.fn();
		const { proc, state } = makeFakeProcess([piCrash]);
		const log = vi.fn();
		installInspectorUncaughtGuard({
			process: proc,
			getInspectorUrl: () => "ws://127.0.0.1:9229/uuid",
			log,
		});
		state.capture?.(inspectorError());
		expect(piCrash).not.toHaveBeenCalled();
		expect(log).toHaveBeenCalledOnce();
	});

	it("replays every other error to the listeners in registration order", () => {
		const calls: string[] = [];
		const first = vi.fn(() => calls.push("first"));
		const second = vi.fn(() => calls.push("second"));
		const { proc, state } = makeFakeProcess([first, second]);
		installInspectorUncaughtGuard({
			process: proc,
			getInspectorUrl: () => "ws://127.0.0.1:9229/uuid",
			log: vi.fn(),
		});
		const error = new Error("real failure");
		state.capture?.(error);
		expect(first).toHaveBeenCalledWith(error);
		expect(second).toHaveBeenCalledWith(error);
		expect(calls).toEqual(["first", "second"]);
	});

	it("keeps replaying when a listener throws", () => {
		const boom = vi.fn(() => {
			throw new Error("listener failed");
		});
		const after = vi.fn();
		const log = vi.fn();
		const { proc, state } = makeFakeProcess([boom, after]);
		installInspectorUncaughtGuard({
			process: proc,
			getInspectorUrl: () => "ws://127.0.0.1:9229/uuid",
			log,
		});
		state.capture?.(new Error("real failure"));
		expect(after).toHaveBeenCalledOnce();
		expect(log).toHaveBeenCalledOnce();
	});

	it("removes the capture callback on dispose", () => {
		const { proc, state } = makeFakeProcess();
		const guard = installInspectorUncaughtGuard({
			process: proc,
			getInspectorUrl: () => "ws://127.0.0.1:9229/uuid",
			log: vi.fn(),
		});
		expect(state.capture).not.toBeNull();
		guard.dispose();
		expect(state.capture).toBeNull();
	});
});
