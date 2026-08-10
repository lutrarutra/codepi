/**
 * Filter for the terminal data stream (webview side).
 *
 * pi-tui's full re-render path emits `\x1b[2J\x1b[H\x1b[3J` (clear screen,
 * home, clear scrollback) whenever it cannot do an incremental update —
 * terminal resize, a content change above the visible viewport (fires while
 * the final response streams), or a large content shrink. The `\x1b[3J`
 * (CSI "Erase Saved Lines") part wipes the terminal's scrollback and resets
 * the viewport to the top, destroying the user's scroll position and
 * history. CodePi's terminal must never do that, so the scrollback-clear is
 * stripped from the stream before it reaches xterm. The screen clear +
 * redraw still work — xterm keeps the viewport where it is for `\x1b[2J`
 * (verified against xterm 6.0.0: ydisp is untouched).
 *
 * xterm interprets *any* CSI ending in `J` whose FIRST parameter is `3` as
 * "erase saved lines" (its ED handler switches on `params[0]`), not just the
 * bare `\x1b[3J`. Private-mode (`\x1b[?3J`) and multi-parameter
 * (`\x1b[3;0J`, `\x1b[3:0J`) variants clear the scrollback just the same, so
 * the filter matches the whole family. Sequences whose first parameter is not
 * `3` (`\x1b[0J`, `\x1b[2J`, `\x1b[30J`) are left alone.
 *
 * The returned filter is stateful: it holds back a partial CSI tail at the
 * end of a chunk so a `\x1b[3J` split across two writes is still caught
 * (xterm's parser would otherwise reassemble it and clear the scrollback).
 */
export function createScrollbackClearFilter(): (data: string) => string {
	let pending = "";
	const PARTIAL_CSI = /\x1b(?:\[[0-9;?:]{0,12})?$/;
	// CSI [ ? ] <first-param 3> [ ; | : <more params> ] J  — any ED3 form.
	const SCROLLBACK_CLEAR = /\x1b\[\??3(?:[;:][0-9?;:]*)?J/g;
	return (data: string): string => {
		const combined = pending + data;
		const tail = combined.match(PARTIAL_CSI);
		if (tail) {
			pending = tail[0];
			return combined
				.slice(0, combined.length - tail[0].length)
				.replace(SCROLLBACK_CLEAR, "");
		}
		pending = "";
		return combined.replace(SCROLLBACK_CLEAR, "");
	};
}
