/**
 * Augmentation of pi 0.80.1's ExtensionAPI types. This file must remain a
 * MODULE (the import below) so the `declare module` block merges with the real
 * package instead of shadowing it.
 *
 * pi 0.80.1 emits session_switch / session_fork / session_tree /
 * session_shutdown at runtime but omits them from the ExtensionAPI `on()`
 * overloads — the bundled extensions use them, so declare them here.
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
		on(
			event: "session_tree",
			handler: (event: any, ctx: any) => Promise<void> | void,
		): void;
		on(
			event: "session_shutdown",
			handler: (event: any, ctx: any) => Promise<void> | void,
		): void;
	}
}
