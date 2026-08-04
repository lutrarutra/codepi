import type { Terminal } from "@xterm/xterm";
import "./find.css";

export interface FindWidget {
	open: () => void;
	close: () => void;
	isOpen: () => boolean;
}

/**
 * Ctrl+F find widget for the TUI panel — mirror of the VS Code built-in
 * terminal find box: top-right overlay, live incremental search over the
 * whole xterm buffer, all matches highlighted, "x of y" counter, case +
 * whole-word toggles, prev/next navigation.
 *
 * Scaffold stage: DOM + lifecycle (Task 2 wires the xterm search addon).
 * Keystrokes land in the widget's own <input> while open, so nothing leaks
 * to pi.
 */
export function createFindWidget(
	term: Terminal,
	container: HTMLElement,
): FindWidget {
	// Search state (remembered for the panel's lifetime).
	const query = "";
	let open = false;

	// Widget DOM (built lazily on first open).
	let bar: HTMLDivElement | null = null;
	let input: HTMLInputElement | null = null;
	let counter: HTMLSpanElement | null = null;
	let caseBtn: HTMLButtonElement | null = null;
	let wordBtn: HTMLButtonElement | null = null;

	const close = (): void => {
		if (!open) return;
		open = false;
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

		caseBtn = makeButton(
			"codepi-find-toggle codicon codicon-case-sensitive",
			"Match Case",
			"Toggle case-sensitive search",
		);
		wordBtn = makeButton(
			"codepi-find-toggle codicon codicon-word-wrap",
			"Match Whole Word",
			"Toggle whole-word search",
		);
		const upBtn = makeButton(
			"codepi-find-btn codicon codicon-chevron-up",
			"Previous Match",
			"Previous match",
		);
		const downBtn = makeButton(
			"codepi-find-btn codicon codicon-chevron-down",
			"Next Match",
			"Next match",
		);
		const closeBtn = makeButton(
			"codepi-find-btn codicon codicon-close",
			"Close (Esc)",
			"Close find",
		);
		closeBtn.addEventListener("click", close);

		input.addEventListener("keydown", (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				close();
			} else if (
				(e.ctrlKey || e.metaKey) &&
				(e.code === "KeyF" || e.key.toLowerCase() === "f")
			) {
				// Ctrl+F while open: refocus + select all (VS Code behavior).
				e.preventDefault();
				input?.select();
			}
		});

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
		input!.focus();
		input!.select();
	};

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
