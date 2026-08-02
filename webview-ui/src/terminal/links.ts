/**
 * xterm.js integration for CodePi Ctrl+click terminal links (VS Code built-in
 * terminal behavior). The pure link detection lives in the extension's shared
 * module `src/tui/terminal-links.ts` (a port of vscode-main's LinkComputer +
 * terminalLinkParsing); this file wires it into xterm's Linkifier and the
 * built-in OSC 8 hyperlink handler (options.linkHandler), mirroring
 * TerminalLinkManager.
 *
 * Unlike VS Code, the link affordance only appears while the activation
 * modifier is held: xterm's Linkifier still computes links on plain hover,
 * but the hover underline + pointer cursor are hidden by CSS
 * (see links.css) and the tooltip is only shown when the modifier is down.
 */
import type {
	IBufferRange,
	ILink,
	ILinkProvider,
	Terminal,
} from "@xterm/xterm";
import {
	detectWordLinks,
	isActivationModifierDown,
	MAX_LINK_LINE_LENGTH,
	osc8ToCodePiLink,
	type CodePiLink,
} from "../../../src/tui/terminal-links";

export type { CodePiLink } from "../../../src/tui/terminal-links";

/** Short human label for the hover tooltip, mirroring VS Code's. */
export function activationModifierLabel(): string {
	const isMac =
		typeof navigator !== "undefined" &&
		/nav|Mac|Macintosh|MacIntel/i.test(navigator.platform || "");
	return isMac ? "⌘+click" : "Ctrl+click";
}

/** Posts a link activation to the extension host. */
export type LinkPost = (link: CodePiLink) => void;

// ── Activation-modifier gate ─────────────────────────────────

export interface LinkModifierGate {
	isHeld(): boolean;
	onChange(cb: (held: boolean) => void): void;
}

/**
 * Tracks whether the link activation modifier (Ctrl/Cmd/Alt) is held, via
 * capture-phase key listeners + window blur. Toggles `codepi-modifier-held`
 * on the terminal host element; links.css hides link underlines and the
 * pointer cursor while the class is absent, so the hover affordance only
 * appears when the user actually holds the modifier.
 */
export function createLinkModifierGate(term: Terminal): LinkModifierGate {
	const host = term.element;
	if (host) {
		host.classList.add("codepi-link-host");
	}
	let held = false;
	const listeners = new Set<(held: boolean) => void>();
	const update = (next: boolean): void => {
		if (next === held) return;
		held = next;
		if (host) {
			host.classList.toggle("codepi-modifier-held", held);
		}
		for (const cb of listeners) cb(held);
	};
	const onKey = (e: KeyboardEvent): void => {
		update(e.ctrlKey || e.metaKey || e.altKey);
	};
	const onBlur = (): void => update(false);
	window.addEventListener("keydown", onKey, true);
	window.addEventListener("keyup", onKey, true);
	window.addEventListener("blur", onBlur);
	return {
		isHeld: () => held,
		onChange: (cb) => listeners.add(cb),
	};
}

// ── Hover state (for showing the tooltip on modifier-down) ──

/** The link currently under the mouse (set by the hover callbacks). */
export interface LinkHoverState {
	current?: { event: MouseEvent; text: string };
	set(event: MouseEvent, text: string): void;
	clear(): void;
}

export function createLinkHoverState(): LinkHoverState {
	return {
		current: undefined,
		set(event, text) {
			this.current = { event, text };
		},
		clear() {
			this.current = undefined;
		},
	};
}

/**
 * Custom link provider: scans the (wrapped) buffer line under the mouse for
 * words. xterm's Linkifier computes hover links; the underline + pointer
 * cursor are CSS-gated on the modifier, and the tooltip is only shown while
 * the modifier is held. Activation requires the modifier and is forwarded to
 * the extension via `post`.
 */
export function createTerminalLinkProvider(
	term: Terminal,
	post: LinkPost,
	tooltip: LinkTooltip,
	gate: LinkModifierGate,
	hoverState: LinkHoverState,
): ILinkProvider {
	const onHover = (event: MouseEvent, text: string): void => {
		hoverState.set(event, text);
		if (gate.isHeld()) {
			tooltip.show(event, text);
		} else {
			tooltip.hide();
		}
	};
	const onLeave = (): void => {
		hoverState.clear();
		tooltip.hide();
	};
	return {
		provideLinks(
			bufferLineNumber: number,
			callback: (links: ILink[] | undefined) => void,
		): void {
			const entries = linksForBufferLine(term, bufferLineNumber);
			if (!entries) {
				callback(undefined);
				return;
			}
			callback(
				entries.map((e) => ({
					range: toBufferRange(e.startY, term.cols, e.link.start, e.link.end),
					text: e.link.text,
					decorations: { underline: true, pointerCursor: true },
					activate: (event: MouseEvent) => {
						if (!isActivationModifierDown(event)) return;
						post(e.link);
					},
					hover: onHover,
					leave: onLeave,
				})),
			);
		},
	};
}

/**
 * xterm's built-in OSC 8 hyperlink provider activates through
 * `options.linkHandler`. Route those (pi emits OSC 8 links when it detects
 * hyperlink support) through the same modifier gate + extension post, exactly
 * like VS Code's TerminalLinkManager does.
 */
export function createOsc8LinkHandler(
	post: LinkPost,
	tooltip: LinkTooltip,
	gate: LinkModifierGate,
	hoverState: LinkHoverState,
) {
	return {
		allowNonHttpProtocols: true,
		activate: (event: MouseEvent, text: string) => {
			if (!isActivationModifierDown(event)) return;
			post(osc8ToCodePiLink(text));
		},
		hover: (event: MouseEvent, text: string) => {
			hoverState.set(event, text);
			if (gate.isHeld()) {
				tooltip.show(event, text);
			} else {
				tooltip.hide();
			}
		},
		leave: () => {
			hoverState.clear();
			tooltip.hide();
		},
	};
}

interface LinkEntry {
	link: CodePiLink;
	startY: number;
}

/** Scan the full logical (wrapped) line containing `bufferLineNumber`. */
function linksForBufferLine(
	term: Terminal,
	bufferLineNumber: number,
): LinkEntry[] | undefined {
	const buffer = term.buffer.active;

	// xterm's linkifier passes 1-based buffer rows (position.y = row + 1 —
	// its OscLinkProvider reads lines.get(e - 1) and Math.ceil()s the mouse
	// coordinate). Convert to 0-based row for the buffer API.
	let startY = bufferLineNumber - 1;

	// Walk up while rows are wrapped to find the start of the logical line.
	while (startY > 0) {
		const line = buffer.getLine(startY);
		if (line && line.isWrapped) startY--;
		else break;
	}

	// Collect rows of the logical line.
	let text = "";
	let y = startY;
	for (;;) {
		const line = buffer.getLine(y);
		if (!line) break;
		text += line.translateToString(true, 0, term.cols);
		const next = buffer.getLine(y + 1);
		if (!next || !next.isWrapped) break;
		y++;
	}

	if (text.length === 0 || text.length > MAX_LINK_LINE_LENGTH) return undefined;
	return detectWordLinks(text).map((link) => ({ link, startY }));
}

/** Convert a 0-based char offset into a buffer cell range (1-based x and y). */
function toBufferRange(
	startY: number,
	cols: number,
	start: number,
	end: number,
): IBufferRange {
	return {
		start: {
			x: (start % cols) + 1,
			y: startY + 1 + Math.floor(start / cols),
		},
		end: {
			x: ((end - 1) % cols) + 1,
			y: startY + 1 + Math.floor((end - 1) / cols),
		},
	};
}

export interface LinkTooltip {
	show(event: MouseEvent, text: string): void;
	hide(): void;
}

/**
 * Small "Ctrl+click to follow" tooltip, in the spirit of VS Code's terminal
 * link hover. Uses the `xterm-hover` class so mouse events on it don't fall
 * through to other links (xterm checks for that class in its linkifier).
 */
export function createLinkTooltip(term: Terminal): LinkTooltip {
	let el: HTMLDivElement | null = null;
	return {
		show(event: MouseEvent, text: string): void {
			if (!el) {
				el = document.createElement("div");
				el.className = "xterm-hover codepi-link-hover";
				el.style.position = "absolute";
				el.style.padding = "3px 8px";
				el.style.background = "#2d2d30";
				el.style.color = "#d4d4d4";
				el.style.border = "1px solid #5a5a5a";
				el.style.borderRadius = "4px";
				el.style.fontSize = "12px";
				el.style.fontFamily =
					'"FiraCode Nerd Font", "SFMono-Regular", monospace';
				el.style.whiteSpace = "nowrap";
				el.style.pointerEvents = "none";
				el.style.zIndex = "30";
				if (term.element) {
					term.element.appendChild(el);
				}
			}
			const rect = term.element?.getBoundingClientRect();
			if (!rect) return;
			const label = activationModifierLabel();
			const display = text.length > 80 ? text.slice(0, 77) + "…" : text;
			el.textContent = `${display} — ${label} to follow`;
			el.style.left = `${Math.min(event.clientX - rect.left + 12, Math.max(rect.width - 160, 0))}px`;
			el.style.top = `${Math.min(event.clientY - rect.top + 14, Math.max(rect.height - 24, 0))}px`;
		},
		hide(): void {
			el?.remove();
			el = null;
		},
	};
}
