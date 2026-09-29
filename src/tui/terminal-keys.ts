/**
 * Modifier+arrow chords for the CodePi TUI webview.
 *
 * xterm already encodes modified arrows the way terminal applications expect
 * (Ctrl+Left/Right → `\x1b[1;5D` / `\x1b[1;5C`, which pi's editor binds to
 * word movement). pi's editor additionally understands the readline chords
 * `\x01` (Ctrl+A, start of line) and `\x05` (Ctrl+E, end of line), and has NO
 * binding for Ctrl/Cmd+Up or Ctrl/Cmd+Down.
 *
 * CodePi therefore remaps only the chords that would otherwise be dead keys,
 * and leaves every chord pi already handles to xterm:
 *
 * - Cmd+Left/Right: macOS's native text-field "start/end of line" chords, which
 *   VS Code users expect in every text input. These have no terminal encoding,
 *   so they are remapped to `\x01` / `\x05`.
 * - Ctrl+Up/Down (and Cmd+Up/Down): unbound in pi, remapped to `\x01` / `\x05`
 *   as well, matching the macOS document-home/end chords.
 * - Ctrl+Left/Right: NOT intercepted. xterm emits pi's native word-navigation
 *   sequences, which is what a plain `pi` session in a terminal does — on
 *   Windows/Linux this must not be turned into line start/end.
 *
 * The decision lives here, away from the xterm glue, so it is unit-testable
 * (see src/__tests__/terminal-keys.test.ts). This module is shared with the
 * webview bundle the same way `src/tui/terminal-links.ts` is, so it must stay
 * DOM- and platform-free.
 */

/** Ctrl+A — pi's editor: move to the start of the input line. */
export const LINE_START_INPUT = "\x01";

/** Ctrl+E — pi's editor: move to the end of the input line. */
export const LINE_END_INPUT = "\x05";

/**
 * The subset of a KeyboardEvent this resolution needs. Declared structurally
 * rather than as `KeyboardEvent` because this module is compiled by the
 * extension's tsconfig (lib: ES2022, no DOM).
 */
export interface ArrowChordEvent {
	key: string;
	ctrlKey: boolean;
	metaKey: boolean;
	altKey: boolean;
	shiftKey: boolean;
}

/**
 * Resolve a keyboard event to the bytes CodePi must feed pi, or `undefined`
 * when the event should fall through to xterm's own encoding.
 *
 * Shift and Alt variants are never touched: Shift+arrow extends a selection in
 * xterm and Alt+arrow is left to the host's own handling.
 */
export function resolveArrowChord(e: ArrowChordEvent): string | undefined {
	if (e.altKey || e.shiftKey) return undefined;

	const chorded = e.ctrlKey || e.metaKey;
	if (!chorded) return undefined;

	switch (e.key) {
		case "ArrowLeft":
			// Cmd (macOS line start) is remapped; Ctrl falls through so xterm
			// sends \x1b[1;5D and pi moves by a word.
			return e.metaKey && !e.ctrlKey ? LINE_START_INPUT : undefined;
		case "ArrowRight":
			// Same split as ArrowLeft: Cmd → line end, Ctrl → pi's word-right.
			return e.metaKey && !e.ctrlKey ? LINE_END_INPUT : undefined;
		case "ArrowUp":
			// Unbound in pi, so Cmd or Ctrl can both mean "start of line".
			return LINE_START_INPUT;
		case "ArrowDown":
			// Unbound in pi, so Cmd or Ctrl can both mean "end of line".
			return LINE_END_INPUT;
		default:
			return undefined;
	}
}
