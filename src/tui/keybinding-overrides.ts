/**
 * pi keybindings that must not be active inside CodePi.
 *
 * pi's InteractiveMode builds its keybindings from ~/.pi/agent/keybindings.json
 * and offers no override hook, so CodePi layers these on top of the user's
 * bindings of each session's KeybindingsManager — also after /reload, which
 * re-reads the file through setUserBindings(). Unbound actions disappear from
 * pi's startup hints and /hotkeys as well.
 *
 * - app.suspend (ctrl+z): pi stops its TUI and sends SIGTSTP to its process
 *   group — here the VS Code extension host — then waits for a SIGCONT that
 *   never comes; the session's TUI is dead until the tab is closed.
 * - app.exit (ctrl+d): the webview swallows Ctrl+D anyway (closing a session
 *   is /quit or closing the tab); unbinding it removes the "ctrl+d to exit"
 *   hint that never worked.
 * - app.clear (ctrl+c): the webview makes Ctrl+C copy-only and never sends
 *   it to pi, so "ctrl+c to clear" and "ctrl+c twice to exit" never worked
 *   either.
 *
 * pi's startup header lists hints for unbound actions without a key; the
 * host-integration patch leaves those out.
 */
export const CODEPI_KEYBINDING_OVERRIDES: Readonly<Record<string, string[]>> = {
	"app.suspend": [],
	"app.exit": [],
	"app.clear": [],
};

interface KeybindingsLike {
	setUserBindings(bindings: Record<string, unknown>): void;
	getUserBindings(): Record<string, unknown>;
}

const isKeybindingsLike = (value: unknown): value is KeybindingsLike =>
	!!value &&
	typeof (value as KeybindingsLike).setUserBindings === "function" &&
	typeof (value as KeybindingsLike).getUserBindings === "function";

/**
 * Apply the overrides to an InteractiveMode instance (its `keybindings`
 * field). Returns false when the instance no longer has that shape, so the
 * caller can log it (src/__tests__/keybinding-overrides.test.ts guards the
 * upstream contract).
 */
export function applyKeybindingOverrides(
	interactiveMode: unknown,
	overrides: Readonly<Record<string, string[]>> = CODEPI_KEYBINDING_OVERRIDES,
): boolean {
	const kb = (interactiveMode as { keybindings?: unknown } | undefined)?.keybindings;
	if (!isKeybindingsLike(kb)) return false;
	const setUserBindings = kb.setUserBindings.bind(kb);
	kb.setUserBindings = (bindings: Record<string, unknown>) =>
		setUserBindings({ ...bindings, ...overrides });
	kb.setUserBindings(kb.getUserBindings());
	return true;
}
