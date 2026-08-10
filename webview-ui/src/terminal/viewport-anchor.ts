import type { Terminal } from "@xterm/xterm";

export interface ViewportAnchor {
	/**
	 * The user moved the viewport themselves (wheel, scrollbar drag, find
	 * navigation) — point the anchor at the new viewport top and briefly
	 * suppress restoration so their input is never fought.
	 */
	noteUserScroll: () => void;
	/**
	 * The user started dragging the scrollbar. While dragging, every scroll
	 * event re-anchors so the anchor follows the drag (the drag itself is
	 * user intent, but no wheel events fire during it).
	 */
	beginDrag: () => void;
	/** The user released the scrollbar — stop following the drag. */
	endDrag: () => void;
	/**
	 * The viewport scrolled for any reason (user or programmatic). Only
	 * re-anchors while a scrollbar drag is in progress; ordinary scrolls are
	 * ignored so programmatic moves (content-following, bug-yanks) never
	 * silently move the anchor and defeat drift detection.
	 */
	viewportScrolled: () => void;
	/**
	 * Content was applied to the buffer (a write batch parsed, a resize
	 * reflowed). If the user is scrolled up and the viewport has drifted off
	 * the content they were reading, restore it.
	 */
	keepAnchored: () => void;
	dispose: () => void;
}

/**
 * Viewport content-anchor for the CodePi TUI terminal.
 *
 * Hard guarantee: no content change may ever yank the user's scroll position
 * to the top. The scrollback-clear filter strips pi's `\x1b[3J`, but other
 * events can still move the viewport under the user: a stray ED3 variant, a
 * resize-trim clamp (fit() reflows and can reduce ydisp to 0 when the buffer
 * is near its scrollback limit), or xterm's overflow content-following once
 * the scrollback fills (every recycled line decrements ydisp).
 *
 * While the user is scrolled up, an xterm marker is kept on the line at the
 * top of the viewport. Markers track their line through scrolls, row shifts
 * and reflows, so the marker IS the content the user is reading. After every
 * write batch and resize, if the viewport has drifted off that content, it
 * is restored with scrollToLine(). The marker only moves when the USER moves
 * the viewport (wheel / scrollbar drag / find navigation) — programmatic
 * moves (xterm's own content-following, the guard's own restores) never
 * re-anchor, so a bug-yank always shows up as drift and gets restored.
 */
export function createViewportAnchor(term: Terminal): ViewportAnchor {
	let anchor: { line: number; dispose: () => void } | null = null;
	let lastUserScrollAt = 0;
	let lastAnchorRow = -1;
	let dragging = false;

	/** Point the marker at the current top-of-viewport line (if scrolled up). */
	const refreshAnchor = (): void => {
		const b = term.buffer.active;
		const top = b.viewportY;
		if (top === lastAnchorRow) return; // viewport didn't move
		lastAnchorRow = top;
		anchor?.dispose();
		anchor = null;
		// At the bottom there is nothing to anchor — the viewport follows
		// the stream and the guard must not interfere.
		if (top >= b.baseY) return;
		const marker = term.registerMarker(top - (b.baseY + b.cursorY));
		if (marker) anchor = marker;
	};

	return {
		noteUserScroll(): void {
			lastUserScrollAt = Date.now();
			refreshAnchor();
		},
		beginDrag(): void {
			dragging = true;
			lastUserScrollAt = Date.now();
			refreshAnchor();
		},
		endDrag(): void {
			dragging = false;
			lastUserScrollAt = Date.now();
			refreshAnchor();
		},
		viewportScrolled(): void {
			if (dragging) {
				lastUserScrollAt = Date.now();
				refreshAnchor();
			}
		},
		keepAnchored(): void {
			if (dragging) return; // user owns the viewport while dragging
			const b = term.buffer.active;
			if (b.viewportY >= b.baseY) return; // at bottom: follow the stream
			if (Date.now() - lastUserScrollAt < 250) return; // user owns it now
			if (!anchor || anchor.line < 0) return; // no anchor (history wiped)
			if (b.viewportY === anchor.line) return; // still on the content
			term.scrollToLine(anchor.line);
		},
		dispose(): void {
			anchor?.dispose();
			anchor = null;
			dragging = false;
		},
	};
}
