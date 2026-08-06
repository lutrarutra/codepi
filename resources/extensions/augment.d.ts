/**
 * Augmentation of pi's ExtensionAPI types. This file must remain a
 * MODULE (the import below) so the `declare module` block merges with the real
 * package instead of shadowing it.
 *
 * session_tree / session_shutdown are typed upstream since 0.83.0; only
 * session_switch / session_fork are missing from the ExtensionAPI `on()`
 * overloads, so declare just those here (the bundled extensions subscribe to
 * them; they are no-ops when pi does not emit them).
 */
import type {} from "@earendil-works/pi-coding-agent";

declare module "@earendil-works/pi-coding-agent" {
	interface ExtensionAPI {
		on(
			event: "session_switch",
			handler: (event: any, ctx: any) => Promise<void> | void,
		): void;
		on(
			event: "session_fork",
			handler: (event: any, ctx: any) => Promise<void> | void,
		): void;
	}
}
