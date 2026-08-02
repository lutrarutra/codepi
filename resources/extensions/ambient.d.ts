/**
 * Ambient declarations for pi packages that are resolved at RUNTIME by pi's
 * jiti loader (with package aliases) rather than from this repo's node_modules
 * layout. This file has NO imports on purpose — it must stay a script file so
 * these count as ambient module declarations (a module file would interpret
 * them as augmentations of unresolvable packages and drop them).
 *
 * The @earendil-works/pi-coding-agent augmentation lives in augment.d.ts.
 */
declare module "@earendil-works/pi-tui" {
	export const Container: any;
	export const DynamicBorder: any;
	export const Key: any;
	export const Markdown: any;
	export const SelectList: any;
	export const Text: any;
	export const matchesKey: any;
	export type SelectItem = any;
	export function truncateToWidth(text: string, width: number): string;
	export function visibleWidth(text: string): number;
}

declare module "@earendil-works/pi-ai" {
	export type AssistantMessage = any;
	export type Message = any;
}
