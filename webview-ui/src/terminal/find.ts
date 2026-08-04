import { SearchAddon } from "@xterm/addon-search";
import type { Terminal } from "@xterm/xterm";
import "./find.css";

export interface FindWidget {
	open: () => void;
	close: () => void;
	isOpen: () => boolean;
}

/** Read a VS Code theme variable with a fallback (mirrors terminal.ts). */
function cssVar(name: string, fallback: string): string {
	const v = getComputedStyle(document.documentElement).getPropertyValue(name);
	return v.trim() || fallback;
}

/**
 * Ctrl+F find widget for the TUI panel — mirror of the VS Code built-in
 * terminal find box: top-right overlay, live incremental search over the
 * whole xterm buffer, all matches highlighted, "x of y" counter, case +
 * whole-word toggles, prev/next navigation.
 *
 * The SearchAddon does the buffer scanning and match decoration highlighting
 * (capped at 1000 matches — see the counter's "+ matches" fallback) and
 * re-runs the search itself ~200ms after new terminal output. Keystrokes
 * land in the widget's own <input> while open, so nothing leaks to pi.
 */
export function createFindWidget(
	term: Terminal,
	container: HTMLElement,
): FindWidget {
	const addon = new SearchAddon();
	term.loadAddon(addon);

	// Search state (remembered for the panel's lifetime).
	let query = "";
	let caseSensitive = false;
	let wholeWord = false;
	let open = false;

	// Result state, fed by addon.onDidChangeResults.
	let resultCount = 0;
	let resultIndex = -1;

	// Widget DOM (built lazily on first open).
	let bar: HTMLDivElement | null = null;
	let input: HTMLInputElement | null = null;
	let counter: HTMLSpanElement | null = null;
	let caseBtn: HTMLButtonElement | null = null;
	let wordBtn: HTMLButtonElement | null = null;

	/** Terminal may be disposed while the widget is in use — never throw. */
	const safe = (fn: () => void): void => {
		try {
			fn();
		} catch {
			/* terminal disposed */
		}
	};

	// Match colors mirror the VS Code built-in terminal: other matches use
	// the "highlight" variable (yellow), the current match the "match"
	// variable (stronger accent). xterm's color parser accepts the themes'
	// 8-digit hex/rgba values despite the d.ts's "#RRGGBB" note.
	const decorations = (): {
		matchBackground?: string;
		matchBorder?: string;
		matchOverviewRuler: string;
		activeMatchBackground?: string;
		activeMatchBorder?: string;
		activeMatchColorOverviewRuler: string;
	} => ({
		matchBackground: cssVar(
			"--vscode-terminal-findMatchHighlightBackground",
			"#ea5c0055",
		),
		matchBorder: "transparent",
		matchOverviewRuler: "transparent",
		activeMatchBackground: cssVar(
			"--vscode-terminal-findMatchBackground",
			"#d186167e",
		),
		activeMatchBorder: "transparent",
		activeMatchColorOverviewRuler: "transparent",
	});

	const searchOptions = (incremental: boolean) => ({
		incremental,
		caseSensitive,
		wholeWord,
		decorations: decorations(),
	});

	const updateCounter = (): void => {
		if (!counter) return;
		counter.classList.remove("no-results");
		if (!query) {
			counter.textContent = "";
			return;
		}
		if (resultCount === 0) {
			counter.textContent = "0 of 0";
			counter.classList.add("no-results");
			return;
		}
		// resultIndex is -1 when the 1000-match highlight cap is exceeded.
		counter.textContent =
			resultIndex >= 0
				? `${resultIndex + 1} of ${resultCount}`
				: `${resultCount}+ matches`;
	};

	/** Live re-search from the current buffer position (per keystroke). */
	const runSearch = (): void => {
		query = input?.value ?? "";
		if (!query) {
			safe(() => addon.clearDecorations());
			resultCount = 0;
			resultIndex = -1;
			updateCounter();
			return;
		}
		safe(() => addon.findNext(query, searchOptions(true)));
	};

	const next = (): void => {
		if (!query) return;
		safe(() => addon.findNext(query, searchOptions(false)));
	};
	const prev = (): void => {
		if (!query) return;
		safe(() => addon.findPrevious(query, searchOptions(false)));
	};

	const toggleCase = (): void => {
		caseSensitive = !caseSensitive;
		caseBtn?.classList.toggle("active", caseSensitive);
		caseBtn?.setAttribute("aria-pressed", String(caseSensitive));
		if (query) safe(() => addon.findNext(query, searchOptions(false)));
	};
	const toggleWord = (): void => {
		wholeWord = !wholeWord;
		wordBtn?.classList.toggle("active", wholeWord);
		wordBtn?.setAttribute("aria-pressed", String(wholeWord));
		if (query) safe(() => addon.findNext(query, searchOptions(false)));
	};

	const close = (): void => {
		if (!open) return;
		open = false;
		safe(() => addon.clearDecorations());
		if (bar) bar.classList.remove("open");
		term.focus();
	};

	const buildBar = (): void => {
		bar = document.createElement("div");
		bar.className = "codepi-find";
		bar.setAttribute("role", "search");

		input = document.createElement("input");
		input.className = "codepi-find-input";
		input.type = "text";
		input.placeholder = "Find";
		input.spellcheck = false;
		input.setAttribute("aria-label", "Find in terminal");

		counter = document.createElement("span");
		counter.className = "codepi-find-counter";
		counter.setAttribute("aria-live", "polite");

		caseBtn = makeButton(
			"codepi-find-toggle",
			"Match Case",
			"Toggle case-sensitive search",
		);
		caseBtn.textContent = "Aa";
		wordBtn = makeButton(
			"codepi-find-toggle",
			"Match Whole Word",
			"Toggle whole-word search",
		);
		wordBtn.textContent = "ab|";
		const upBtn = makeButton(
			"codepi-find-btn",
			"Previous Match",
			"Previous match",
		);
		upBtn.textContent = "↑";
		const downBtn = makeButton(
			"codepi-find-btn",
			"Next Match",
			"Next match",
		);
		downBtn.textContent = "↓";
		const closeBtn = makeButton(
			"codepi-find-btn",
			"Close (Esc)",
			"Close find",
		);
		closeBtn.textContent = "×";
		caseBtn.addEventListener("click", toggleCase);
		wordBtn.addEventListener("click", toggleWord);
		upBtn.addEventListener("click", prev);
		downBtn.addEventListener("click", next);
		closeBtn.addEventListener("click", close);

		// Typing → live incremental search. No debounce: the addon scans
		// synchronously and the VS Code terminal doesn't debounce either.
		input.addEventListener("input", runSearch);
		input.addEventListener("keydown", (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				close();
			} else if (e.key === "Enter") {
				e.preventDefault();
				if (e.shiftKey) prev();
				else next();
			} else if (e.key === "ArrowUp") {
				e.preventDefault();
				prev();
			} else if (e.key === "ArrowDown") {
				e.preventDefault();
				next();
			} else if (
				(e.ctrlKey || e.metaKey) &&
				(e.code === "KeyF" || e.key.toLowerCase() === "f")
			) {
				// Ctrl+F while open: refocus + select all (VS Code behavior).
				e.preventDefault();
				input?.select();
			}
		});
		// Current-match accent disappears when focus leaves the widget
		// (matches VS Code's terminal; the next search restores it).
		input.addEventListener("blur", () =>
			safe(() => addon.clearActiveDecoration()),
		);

		// Clicks inside the bar must never bubble to the container's
		// mousedown → term.focus() listener (which would steal input focus).
		bar.addEventListener("mousedown", (e) => e.stopPropagation());

		bar.append(input, caseBtn, wordBtn, upBtn, downBtn, counter, closeBtn);
		container.appendChild(bar);
	};

	const show = (): void => {
		if (open) {
			// Already open: refocus + select all (VS Code behavior).
			input?.focus();
			input?.select();
			return;
		}
		open = true;
		if (!bar) buildBar();
		bar?.classList.add("open");
		input!.value = query; // restore last query
		updateCounter();
		input!.focus();
		input!.select();
		// Re-apply highlights immediately (VS Code restores them on reopen).
		if (query) safe(() => addon.findNext(query, searchOptions(false)));
	};

	addon.onDidChangeResults((e) => {
		resultIndex = e.resultIndex;
		resultCount = e.resultCount;
		updateCounter();
	});

	return { open: show, close, isOpen: () => open };
}

function makeButton(
	className: string,
	title: string,
	ariaLabel: string,
): HTMLButtonElement {
	const b = document.createElement("button");
	b.className = className;
	b.title = title;
	b.setAttribute("aria-label", ariaLabel);
	b.type = "button";
	return b;
}
