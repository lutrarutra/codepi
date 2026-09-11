/**
 * uncaught-guard — survive Node's inspector network-tracking bug.
 *
 * When a JS debugger is attached and the Network view is enabled
 * (`debug.javascript.enableNetworkView`, default true in current VS Code),
 * js-debug enables the CDP `Network` domain. Node then instruments every
 * HTTP response in this process and broadcasts `Network.*` events to the
 * client. For some responses no `dataLength` is recorded, and Node's own
 * validator throws from inside the socket's data handler:
 *
 *   TypeError: Missing dataLength in event
 *       at broadcastToFrontend (node:inspector:212:3)
 *       at Object.dataReceived (node:inspector:221:29)
 *       at IncomingMessage.<anonymous> (node:internal/inspector/network_http:140:13)
 *
 * That is an async uncaughtException raised by the runtime, not by CodePi,
 * pi or the request itself (the request completes fine). pi treats any
 * uncaughtException as fatal — `uncaughtCrash()` unregisters its signal
 * handlers, kills detached children, stops the TUI and calls
 * `process.exit(1)` — so a single benign inspector hiccup tears down a
 * perfectly healthy session, with no way to recover the panel.
 *
 * The guard below takes over uncaught-exception capture (Node does NOT emit
 * `'uncaughtException'` while a capture callback is set, so pi's handler never
 * sees the benign error) and replays every other error to the registered
 * listeners in order, preserving pi's and VS Code's behavior exactly.
 *
 * Scope: installed only while the process is inspectable (`inspector.url()`
 * is present), which is the only situation in which the Network domain can be
 * enabled — production runs never install anything.
 */
import { url as inspectorUrl } from "node:inspector";

/**
 * Error messages Node's inspector network tracking throws while broadcasting
 * CDP `Network.*` events (node:inspector `broadcastToFrontend`). Kept as a
 * family because the missing field varies with the response shape.
 */
const INSPECTOR_NETWORK_ERROR =
	/^(?:Missing .+ in event|Request data is not finished yet|Unable to serialize binary request body)$/;

/**
 * Whether `error` is one of Node's inspector network-tracking validation
 * errors. Requires both the known message family AND an inspector frame in
 * the stack, so ordinary application errors can never match.
 */
export function isBenignInspectorError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	if (!INSPECTOR_NETWORK_ERROR.test(error.message)) return false;
	const stack = error.stack ?? "";
	return (
		stack.includes("node:inspector") ||
		stack.includes("node:internal/inspector/")
	);
}

export interface InspectorUncaughtGuardOptions {
	/** Injectable for tests. `undefined` means "not inspectable". */
	getInspectorUrl?: () => string | undefined;
	/** Injectable for tests. */
	process?: NodeJS.Process;
	/** Injectable for tests. */
	log?: (message: string, error: unknown) => void;
}

export interface InspectorUncaughtGuard {
	/** Remove the capture callback again (no-op when nothing was installed). */
	dispose: () => void;
}

/**
 * Swallow the benign inspector error family while this process is
 * inspectable; replay everything else to the `'uncaughtException'` listeners
 * that Node would otherwise have called.
 *
 * Idempotent: does nothing when the process is not inspectable or when some
 * other component already owns the capture callback.
 */
export function installInspectorUncaughtGuard(
	options: InspectorUncaughtGuardOptions = {},
): InspectorUncaughtGuard {
	const proc = options.process ?? process;
	const readInspectorUrl = options.getInspectorUrl ?? inspectorUrl;
	const log =
		options.log ??
		((message: string, error: unknown) => console.warn(message, error));

	const noop: InspectorUncaughtGuard = { dispose: () => {} };
	// No inspector port → the CDP Network domain cannot be enabled → the bug
	// cannot fire. Leave the process alone.
	if (!readInspectorUrl()) return noop;
	// Another owner (e.g. a future VS Code build) wins — never fight over it.
	if (proc.hasUncaughtExceptionCaptureCallback()) return noop;

	const replay = (error: unknown): void => {
		// Node skips the 'uncaughtException' event while a capture callback is
		// installed, so deliver it to every listener in registration order —
		// exactly what Node would have done.
		for (const listener of proc.listeners("uncaughtException")) {
			try {
				(listener as (error: unknown) => void)(error);
			} catch (listenerError) {
				log(
					"[CodePi] an uncaughtException listener threw while replaying the original error:",
					listenerError,
				);
			}
		}
	};

	proc.setUncaughtExceptionCaptureCallback((error: unknown) => {
		if (isBenignInspectorError(error)) {
			log(
				"[CodePi] ignored a benign node:inspector network error (debugger Network view enabled) — the session keeps running:",
				error,
			);
			return;
		}
		replay(error);
	});

	return {
		dispose: () => proc.setUncaughtExceptionCaptureCallback(null),
	};
}
