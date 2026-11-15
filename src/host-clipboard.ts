/**
 * Route pi's clipboard writes (/copy, Ctrl+X) through VS Code's clipboard.
 *
 * pi copies with native tools (pbcopy, clip, xclip/xsel/wl-copy) and falls
 * back to an OSC 52 sequence written to process.stdout. In CodePi neither
 * reliably reaches the user: Linux machines often lack xclip ("Clipboard
 * unavailable: install xclip"), remote and container hosts have no display,
 * and process.stdout is the extension host's — VS Code even redefines its
 * `write` as a non-configurable getter, so it cannot be intercepted.
 *
 * CodePi's pi patch adds a host hook to copyToClipboard(): when
 * globalThis.__piHostClipboardWrite is set, pi hands the text to it instead.
 * vscode.env.clipboard writes the user's clipboard, also from Remote-SSH.
 */
export const HOST_CLIPBOARD_KEY = "__piHostClipboardWrite";

/** Register the hook; returns a disposer that removes it. */
export function installHostClipboard(
	writeText: (text: string) => void | Thenable<void>,
	target: Record<string, unknown> = globalThis as unknown as Record<string, unknown>,
): () => void {
	const hook = async (text: string): Promise<void> => {
		await writeText(text);
	};
	target[HOST_CLIPBOARD_KEY] = hook;
	return () => {
		if (target[HOST_CLIPBOARD_KEY] === hook) delete target[HOST_CLIPBOARD_KEY];
	};
}
