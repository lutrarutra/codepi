/**
 * Ctrl+click link detection for the CodePi TUI webview — a faithful port of
 * VS Code's built-in terminal link handling (see the vscode-main submodule).
 *
 * VS Code's terminal makes EVERY word (a run of non-separator characters) a
 * link: hovering underlines it, and Ctrl+click decides what it is — URL →
 * browser, existing file → editor, directory → explorer, anything else →
 * workspace search. That classification lives in the extension host
 * (src/tui/links.ts + extension.ts); this module only segments the line into
 * words, ported from `TerminalWordLinkDetector.detect` +
 * `_parseWords` (terminalWordLinkDetector.ts), including the default
 * `terminal.integrated.wordSeparators` set.
 *
 * One deliberate deviation from VS Code: `[` and `]` are NOT hard word
 * separators. Framework route params (`src/routes/item/[id]/+page.server.ts`)
 * must stay one word so the whole path is Ctrl+clickable; VS Code's default
 * separator set would split that into `src/routes/item/`, `id` and
 * `/+page.server.ts`. Brackets still act as separators inside non-path words
 * (prose like `[WARN]` keeps splitting to `WARN`), via a second pass in
 * `detectWordLinks`.
 *
 * Activation and hover behavior mirror TerminalLinkManager:
 * - xterm's Linkifier draws the hover underline + pointer cursor.
 * - Ctrl+click (also ⌘/Alt, covering both `editor.multiCursorModifier`
 *   configs) posts `codepi:openLink` to the extension.
 * - OSC 8 hyperlinks (pi emits them when it detects hyperlink support) route
 *   through options.linkHandler with the same gate.
 */

/**
 * Hard word separators: VS Code's default `terminal.integrated.wordSeparators`
 * minus `[` and `]`, which are handled contextually in `detectWordLinks` so
 * route params like `[id]` stay attached to path words.
 */
const WORD_SEPARATORS = " (){}',\"`─\u2018\u2019\u201C\u201D|";

/** Brackets split only non-path words (see detectWordLinks). */
const BRACKET_SEPARATOR_REGEX = /[\[\]]/g;

function escapeRegExpCharacters(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildSeparatorRegex(): RegExp {
	// VS Code also treats the powerline symbol range U+E0B0..U+E0BF as
	// separators (terminalWordLinkDetector._refreshSeparatorCodes).
	let separators = WORD_SEPARATORS;
	for (let i = 0xe0b0; i <= 0xe0bf; i++) {
		separators += String.fromCharCode(i);
	}
	return new RegExp(`[${escapeRegExpCharacters(separators)}]`, "g");
}

const WORD_SEPARATOR_REGEX = buildSeparatorRegex();

export interface CodePiLink {
	kind: "word" | "url" | "file";
	/** Full underlined text. */
	text: string;
	/** 0-based char offsets within the logical (wrapped) line. */
	start: number;
	end: number; // exclusive
	/** kind === "url": the URL to open. */
	url?: string;
	/** kind === "file": the path (without the line/col suffix). */
	path?: string;
	/** 1-based line, when the link carried a suffix. */
	line?: number;
	/** 1-based column, when present. */
	column?: number;
}

/** Maximum line length to scan, like VS Code's MaxLineLength. */
export const MAX_LINK_LINE_LENGTH = 2000;

/** Maximum word length treated as a link, like VS Code's word maxLinkLength. */
export const MAX_WORD_LINK_LENGTH = 100;

/**
 * Segment a line into Ctrl+clickable words (VS Code TerminalWordLinkDetector):
 * split on the terminal word separators, drop a trailing `:` from each word
 * (`https://example.com:` → `https://example.com`), skip empties and
 * over-long words. The extension classifies each word on activation.
 *
 * Deviation from VS Code: a word is first split on the hard separators (which
 * EXCLUDE `[`/`]`), then brackets only split words that are not path-like
 * (contain no `/`). So `src/routes/item/[id]/+page.server.ts` stays a single
 * word, while `[WARN]` in prose still splits to `WARN`.
 */
export function detectWordLinks(line: string): CodePiLink[] {
	if (line.length === 0 || line.length > MAX_LINK_LINE_LENGTH) return [];

	const links: CodePiLink[] = [];
	const parts = line.split(WORD_SEPARATOR_REGEX);
	let runningIndex = 0;
	for (const part of parts) {
		if (part.length > 0) {
			const isPathLike = part.includes("/");
			if (isPathLike) {
				pushWord(links, part, runningIndex);
			} else {
				// Non-path word: brackets act as separators, like VS Code.
				let localIndex = 0;
				const bracketParts = part.split(BRACKET_SEPARATOR_REGEX);
				for (const sub of bracketParts) {
					if (sub.length > 0) {
						pushWord(links, sub, runningIndex + localIndex);
					}
					localIndex += sub.length + 1;
				}
			}
		}
		runningIndex += part.length + 1;
	}
	return links;
}

/** Push a single word with the trailing-colon and length rules applied. */
function pushWord(links: CodePiLink[], text: string, start: number): void {
	let end = start + text.length;
	if (text.charAt(text.length - 1) === ":") {
		text = text.slice(0, -1);
		end--;
	}
	if (text.length > 0 && text.length <= MAX_WORD_LINK_LENGTH) {
		links.push({ kind: "word", text, start, end });
	}
}

// ── Activation modifier ─────────────────────────────────────

/**
 * Which modifier activates a link. VS Code's terminal respects
 * `editor.multiCursorModifier` (ctrlCmd → alt+click, otherwise ctrl/cmd+click);
 * this extension accepts all three so the user's Ctrl+click works regardless
 * of their editor config.
 */
export function isActivationModifierDown(event: {
	ctrlKey: boolean;
	metaKey: boolean;
	altKey: boolean;
}): boolean {
	return event.ctrlKey || event.metaKey || event.altKey;
}

/**
 * Convert an OSC 8 hyperlink target (what xterm's built-in hyperlink provider
 * hands to options.linkHandler) into a CodePi link payload. file:// targets
 * are files; everything else opens externally.
 */
export function osc8ToCodePiLink(text: string): CodePiLink {
	if (text.startsWith("file://")) {
		return { kind: "file", text, path: text, start: 0, end: text.length };
	}
	return { kind: "url", text, url: text, start: 0, end: text.length };
}
