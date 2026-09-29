import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import "./links.css";
import {
	type CodePiLink,
	createLinkHoverState,
	createLinkModifierGate,
	createLinkTooltip,
	createOsc8LinkHandler,
	createTerminalLinkProvider,
} from "./links";
import { createScrollbackClearFilter } from "./scrollback";
import { createViewportAnchor } from "./viewport-anchor";
import { createFindWidget } from "./find";
// The modifier+arrow chord table is shared with the extension's source tree
// (the same cross-import as ./links) and kept DOM-free so it is unit-tested.
import { resolveArrowChord } from "../../../src/tui/terminal-keys";

// VSCode injects acquireVsCodeApi() globally — get it once at module level
const vscodeApi =
	typeof acquireVsCodeApi !== "undefined" ? acquireVsCodeApi() : null;

// Persist this panel's session id with VS Code so the tab can be restored
// after a window reload — the extension's registerWebviewPanelSerializer
// receives it back as the webview state and re-wires the session.
const sessionId =
	document
		.querySelector('meta[name="codepi-session-id"]')
		?.getAttribute("content") ?? "";
if (sessionId) {
	try {
		vscodeApi?.setState({ sessionId });
	} catch {
		/* webview disposed */
	}
}

function post(msg: unknown): void {
	try {
		vscodeApi?.postMessage(msg);
	} catch {
		/* webview disposed */
	}
}

// ── Clipboard (copy/paste) ──────────────────────────────────
//
// VS Code grants webview iframes `allow="clipboard-read; clipboard-write"`
// (webviewElement.ts), so navigator.clipboard works while the webview is
// focused. When it's unavailable or rejected (focus quirks, older Electron),
// fall back to the extension host's vscode.env.clipboard — that always
// works, at the cost of a message round-trip.

let clipboardReadResolver: ((text: string) => void) | undefined;

function readClipboardText(): Promise<string> {
	return new Promise((resolve) => {
		let settled = false;
		const done = (text: string) => {
			if (settled) return;
			settled = true;
			clipboardReadResolver = undefined;
			resolve(text);
		};
		const fallback = () => {
			clipboardReadResolver = done;
			post({ command: "tuiClipboardRead" });
			// Safety: never leave the caller waiting on a dead webview/extension.
			setTimeout(() => done(""), 2000);
		};
		try {
			void navigator.clipboard.readText().then(done, fallback);
		} catch {
			fallback();
		}
	});
}

function writeClipboardText(text: string): void {
	try {
		void navigator.clipboard.writeText(text).catch(() => {
			post({ command: "tuiClipboardWrite", text });
		});
	} catch {
		post({ command: "tuiClipboardWrite", text });
	}
}

function fail(message: string): void {
	console.error("[CodePi terminal]", message);
	post({ command: "tuiError", message });
	const el = document.getElementById("terminal");
	if (el) {
		el.textContent = `CodePi terminal error: ${message}`;
		el.style.color = "#f14c4c";
	}
	hideLoading();
}

// ── Read theme colors from VS Code CSS variables ─────────────

function cssVar(name: string, fallback: string): string {
	const v = getComputedStyle(document.documentElement).getPropertyValue(name);
	return v.trim() || fallback;
}

/**
 * Background resolution mirrors VS Code's built-in terminal
 * (terminalInstance.ts getBackgroundColor): terminal.background →
 * editor.background for editor-location terminals.
 */
function readBackground(): string {
	const v = cssVar("--vscode-terminal-background", "");
	// "transparent" falls through to the editor background, mirroring VS
	// Code's terminalInstance.ts getBackgroundColor fallback chain.
	if (v && v !== "transparent") return v;
	return cssVar("--vscode-editor-background", "#1e1e1e");
}

function readTheme() {
	return {
		background: readBackground(),
		foreground: cssVar("--vscode-terminal-foreground", "#cccccc"),
		cursor: cssVar("--vscode-terminalCursor-foreground", "#cccccc"),
		cursorAccent: readBackground(),
		selectionBackground: cssVar(
			"--vscode-terminal-selectionBackground",
			"rgba(255,255,255,0.3)",
		),
		black: cssVar("--vscode-terminal-ansiBlack", "#000000"),
		red: cssVar("--vscode-terminal-ansiRed", "#cd3131"),
		green: cssVar("--vscode-terminal-ansiGreen", "#0dbc79"),
		yellow: cssVar("--vscode-terminal-ansiYellow", "#e5e510"),
		blue: cssVar("--vscode-terminal-ansiBlue", "#2472c8"),
		magenta: cssVar("--vscode-terminal-ansiMagenta", "#bc3fbc"),
		cyan: cssVar("--vscode-terminal-ansiCyan", "#11a8cd"),
		white: cssVar("--vscode-terminal-ansiWhite", "#e5e5e5"),
		brightBlack: cssVar("--vscode-terminal-ansiBrightBlack", "#666666"),
		brightRed: cssVar("--vscode-terminal-ansiBrightRed", "#f14c4c"),
		brightGreen: cssVar("--vscode-terminal-ansiBrightGreen", "#23d18b"),
		brightYellow: cssVar("--vscode-terminal-ansiBrightYellow", "#f5f543"),
		brightBlue: cssVar("--vscode-terminal-ansiBrightBlue", "#3b8eea"),
		brightMagenta: cssVar("--vscode-terminal-ansiBrightMagenta", "#d670d6"),
		brightCyan: cssVar("--vscode-terminal-ansiBrightCyan", "#29b8db"),
		brightWhite: cssVar("--vscode-terminal-ansiBrightWhite", "#e5e5e5"),
	};
}

// ── Create xterm.js terminal ─────────────────────────────────

// Bundled terminal font: Fira Code Nerd Font (SIL OFL 1.1) — the user's
// preferred coding font plus the powerline/nerd symbol glyphs (branch U+E0A0
// in the TUI footer, separators, etc.) in one family, shipped as woff2 in
// media/. monospace is the fallback if the font ever fails to load.
//
// Font family/size are configurable in the CodePi settings sidebar; the
// extension embeds the current values as meta tags in the HTML shell
// (buildTerminalHtml) so this module applies them before the first frame.

function readMeta(name: string): string | undefined {
	return (
		document.querySelector(`meta[name="${name}"]`)?.getAttribute("content") ??
		undefined
	);
}

const FONT_FAMILY =
	readMeta("codepi-font-family")?.trim() || '"FiraCode Nerd Font", monospace';
const FONT_SIZE = Math.min(
	40,
	Math.max(8, Number.parseInt(readMeta("codepi-font-size") ?? "", 10) || 14),
);

/** Fade out the startup loading overlay (PI logo + dots). */
function hideLoading(): void {
	const el = document.getElementById("loading");
	if (el && !el.classList.contains("loading-done")) {
		el.classList.add("loading-done");
	}
}

(async () => {
	try {
		const container = document.getElementById("terminal");
		if (!container) throw new Error("missing #terminal container");

		/**
		 * Paint every layer behind the terminal grid with the terminal's own
		 * background. fit() sizes the grid to whole rows, so a fractional strip
		 * (smaller than one line height) always remains at the bottom; if the
		 * layers behind it resolve a different color, it shows up as a dark
		 * margin. Using the same readBackground() the xterm theme uses makes
		 * them identical by construction.
		 */
		const applyBackground = (): void => {
			const bg = readBackground();
			const layers: Array<HTMLElement | null> = [
				document.documentElement,
				document.body,
				container,
				container.querySelector(".xterm"),
				// xterm.css gives .xterm-viewport a black background; it fills the
				// whole terminal while the grid canvas only covers whole rows, so
				// the leftover bottom strip shows it. Paint it like the rest.
				container.querySelector(".xterm-viewport"),
			];
			for (const el of layers) {
				if (el) el.style.backgroundColor = bg;
			}
		};

		// Preload the configured terminal font BEFORE the first frame. The canvas
		// glyph atlas is built from whatever font is available at draw time and
		// caches the result — a web font arriving after the first paint leaves
		// tofu cached in the atlas (refresh() only redraws rows, it doesn't
		// rebuild glyphs). It's a local file, so this resolves in a few ms.
		if (document.fonts?.load) {
			try {
				await document.fonts.load(`${FONT_SIZE}px ${FONT_FAMILY}`);
			} catch {
				/* reported below */
			}
		}
		// Report whether the font is actually usable, so a silent resource/CSP
		// failure shows up in the extension logs instead of an unexplained tofu.
		const fontOk =
			document.fonts?.check?.(`${FONT_SIZE}px ${FONT_FAMILY}`) ?? false;
		if (!fontOk) {
			console.error(
				"[CodePi-tui] terminal font not available:",
				FONT_FAMILY,
				"— branch icon will render as tofu",
			);
		}
		post({ command: "tuiFontStatus", ok: fontOk });

		// Fira Code Nerd Font primary; monospace fallback (or the user's
		// configured family). Normal text renders in the regular face below,
		// powerline/nerd glyphs come from the same family.
		const term = new Terminal({
			cursorBlink: true,
			convertEol: false,
			scrollback: 10000,
			// xterm 6 defaults this to true: any keydown while scrolled up
			// (e.g. IME composition, arrow keys) calls scrollToBottom and
			// yanks the user out of the history they're reading. The TUI is a
			// chat, not a shell — typing must never move the viewport.
			scrollOnUserInput: false,
			allowProposedApi: true,
			fontFamily: FONT_FAMILY,
			fontSize: FONT_SIZE,
			theme: readTheme(),
		});

		const fit = new FitAddon();
		term.loadAddon(fit);
		term.open(container);
		applyBackground();

		// Viewport content-anchor (see viewport-anchor.ts) — created before
		// the find widget so find navigation can hand its viewport moves to
		// the anchor. Full rationale lives in the module; in short: the
		// user's scroll position must never be yanked to the top by pi's
		// repaints or xterm's overflow behavior.
		const viewportAnchor = createViewportAnchor(term);

		const find = createFindWidget(
			term,
			container,
			() => post({ command: "codepi:newSession" }),
			() => viewportAnchor.noteUserScroll(),
		);

		// Ctrl+click links (VS Code built-in terminal behavior): every word in
		// the TUI output is a link candidate; the hover underline + tooltip only
		// appear while the activation modifier is held, and Ctrl/Cmd/Alt+click
		// opens the link (URL → browser, file → editor, dir → explorer, else →
		// workspace search). The custom provider handles words; pi's OSC 8
		// hyperlinks route through options.linkHandler.
		const linkTooltip = createLinkTooltip(term);
		const linkGate = createLinkModifierGate(term);
		const linkHoverState = createLinkHoverState();
		// While hovering a link, pressing the modifier shows the tooltip right
		// away; releasing it hides both the tooltip and the underline (the
		// underline is CSS-gated via the modifier class on the host).
		linkGate.onChange((held) => {
			if (held && linkHoverState.current) {
				linkTooltip.show(
					linkHoverState.current.event,
					linkHoverState.current.text,
				);
			} else if (!held) {
				linkTooltip.hide();
			}
		});
		const postLink = (link: CodePiLink): void => {
			post({ command: "codepi:openLink", link });
		};
		term.registerLinkProvider(
			createTerminalLinkProvider(
				term,
				postLink,
				linkTooltip,
				linkGate,
				linkHoverState,
			),
		);
		term.options.linkHandler = createOsc8LinkHandler(
			postLink,
			linkTooltip,
			linkGate,
			linkHoverState,
		);

		// Keep the terminal sized to the editor and report the size so the TUI
		// reflows. Only reports when the grid actually changed — the watchdog
		// below calls this continuously, and pi would otherwise re-render the
		// whole screen on every poll.
		const reportSize = (): void => {
			const prevCols = term.cols;
			const prevRows = term.rows;
			try {
				fit.fit();
			} catch {
				return; // layout not ready yet
			}
			if (term.cols !== prevCols || term.rows !== prevRows) {
				post({ command: "tuiResize", cols: term.cols, rows: term.rows });
				console.log(
					"[CodePi-tui] refit",
					container.clientWidth,
					"x",
					container.clientHeight,
					"->",
					term.cols,
					"x",
					term.rows,
				);
			}
		};

		const scheduleFit = (): void => {
			reportSize();
			// One extra pass after layout settles (fonts/measurements change
			// col/row), then report again.
			requestAnimationFrame(() => {
				requestAnimationFrame(reportSize);
			});
		};

		// Input: webview → extension.
		term.onData((data) => {
			post({ command: "tuiInput", data });
		});

		// Copy/paste handling. The TUI runs pi, not a shell: Ctrl+C must never
		// send SIGINT (\x03) and Ctrl+D must never send EOT (\x04) — the only
		// sanctioned ways to end a session are the /quit command or closing the
		// tab. Ctrl+C copies the selection instead; Ctrl+V pastes the system
		// clipboard into the TUI input.
		//
		// Every paste delivery goes through pasteOnce(): xterm invokes the
		// custom key handler from BOTH keydown and keypress, so one Ctrl+V can
		// trigger the clipboard read twice and paste the same text twice — the
		// dedupe collapses the two deliveries (same text within a short
		// window) into a single paste.
		let lastManualPaste = 0; // ms — guards against the host's own paste path
		let lastPastedText = "";
		let lastPastedAt = 0;
		const pasteOnce = (text: string): void => {
			if (!text) return;
			const now = Date.now();
			if (text === lastPastedText && now - lastPastedAt < 600) return;
			lastPastedText = text;
			lastPastedAt = now;
			term.paste(text);
		};
		term.attachCustomKeyEventHandler((e: KeyboardEvent): boolean => {
			// Match physical keys so Ctrl+C/V/D work on any keyboard layout.
			const isKey = (letter: string) =>
				e.code === `Key${letter.toUpperCase()}` ||
				e.key.toLowerCase() === letter;
			const ctrlLike = e.ctrlKey || e.metaKey;
			if (ctrlLike && isKey("c")) {
				// Copy the selection; never signal the TUI.
				e.preventDefault();
				if (term.hasSelection()) {
					writeClipboardText(term.getSelection());
				}
				return false;
			}
			if (ctrlLike && isKey("v")) {
				e.preventDefault();
				lastManualPaste = Date.now();
				void readClipboardText().then((text) => {
					if (text) pasteOnce(text);
				});
				return false;
			}
			if (e.ctrlKey && isKey("d")) {
				// Blocked: must not send EOT to the TUI.
				e.preventDefault();
				return false;
			}
			if (ctrlLike && isKey("f")) {
				// Ctrl+F: open the find widget (focus moves to its input, so
				// the handler's keydown+keypress double-fire never reaches here
				// twice; open() is idempotent anyway).
				e.preventDefault();
				find.open();
				return false;
			}
			if (e.key === "Escape" && find.isOpen()) {
				// Widget open but focus back on the terminal (clicked the grid):
				// Esc closes it instead of reaching pi.
				e.preventDefault();
				find.close();
				return false;
			}
			if (
				(e.key === "Enter" || e.key === "\r" || e.key === "\n") &&
				(e.shiftKey || e.ctrlKey)
			) {
				// Shift+Enter / Ctrl+Enter: insert a newline in the composer
				// instead of submitting the message (pi's editor treats the
				// \x1b[13;2~ sequence as a newline; plain Enter (\r) submits).
				// The handler runs for both keydown and the synthesized keypress,
				// so emit only on keydown.
				e.preventDefault();
				if (e.type === "keydown") {
					term.input("\x1b[13;2~", true);
				}
				return false;
			}
			const arrowInput = resolveArrowChord(e);
			if (arrowInput !== undefined) {
				// Only the chords pi cannot receive from xterm are remapped
				// (Cmd+Left/Right, Ctrl/Cmd+Up/Down); Ctrl+Left/Right resolves
				// to undefined and falls through, so xterm emits pi's native
				// word-navigation sequences (\x1b[1;5D / \x1b[1;5C) instead of
				// line start/end. See src/tui/terminal-keys.ts for the table.
				// Single-byte chunks — pi's editor matches each incoming chunk
				// against key combos as a whole.
				e.preventDefault();
				if (e.type === "keydown") {
					term.input(arrowInput, true);
				}
				return false;
			}
			if (e.key === "Backspace" && !e.altKey && !e.shiftKey && (e.ctrlKey || e.metaKey)) {
				// pi's TUI has no binding for ctrl+backspace (the \x08 it would
				// otherwise receive is dropped as an unknown control char), so
				// remap it to delete-to-line-start (\x15) followed by
				// delete-to-line-end (\x0b) — together they erase the whole
				// input line regardless of cursor position. Cmd+Backspace on
				// macOS gets the same treatment: xterm ignores meta for
				// Backspace (plain single-char delete), and ⌘⌫ is the native
				// "delete line" chord. The bytes must be sent as SEPARATE
				// input events: pi's editor matches each incoming chunk
				// against key combos as a whole, so a combined "\x15\x0b"
				// chunk matches nothing and is dropped. The handler runs for
				// both keydown and the synthesized keypress, so emit only on
				// keydown.
				e.preventDefault();
				if (e.type === "keydown") {
					term.input("\x15", true);
					term.input("\x0b", true);
				}
				return false;
			}
			return true;
		});

		// VS Code's webview host also forwards Ctrl+V (and the context-menu
		// Paste action) into the iframe as document.execCommand('paste'), which
		// fires a paste event; xterm has its own paste listener on the inner
		// element. Swallow it in the capture phase (before xterm) so a paste is
		// never delivered twice, and use it as the fallback path when the
		// keydown handler didn't run (e.g. context-menu Paste).
		container.addEventListener(
			"paste",
			(e: ClipboardEvent) => {
				e.preventDefault();
				e.stopPropagation();
				if (Date.now() - lastManualPaste < 1000) return; // already pasted via keydown
				const text = e.clipboardData?.getData("text/plain");
				if (text) {
					pasteOnce(text);
				} else {
					void readClipboardText().then((t) => {
						if (t) pasteOnce(t);
					});
				}
			},
			true,
		);

		// Output: extension → webview. pi-tui's full re-renders emit
		// \x1b[3J (clear scrollback), which would jump the viewport to the
		// top and destroy the user's history — strip it from the stream.
		const scrollbackFilter = createScrollbackClearFilter();
		let firstDataHandled = false;
		window.addEventListener("message", (e: MessageEvent) => {
			const msg = e.data as {
				command?: string;
				data?: string;
				text?: string;
			};
			if (!msg || typeof msg !== "object") return;
			switch (msg.command) {
				case "tuiData":
					if (typeof msg.data === "string") {
						term.write(scrollbackFilter(msg.data));
						// The loading overlay is dismissed on the FIRST terminal
						// output as well as on tuiLoadingDone: output only flows
						// once the backend is live, so first-data is the definitive
						// signal. This covers the cross-window-drag case, where the
						// transferred webview can (re)load AFTER tuiLoadingDone was
						// already posted and lost — the overlay would otherwise
						// stay up forever over a live terminal.
						if (!firstDataHandled) {
							firstDataHandled = true;
							hideLoading();
						}
					}
					break;
				case "tuiClipboardData":
					clipboardReadResolver?.(typeof msg.text === "string" ? msg.text : "");
					break;
				case "tuiLoadingDone":
					// Backend is live — fade out the startup overlay (PI logo + dots).
					hideLoading();
					break;
			}
		});

		// ── Viewport content-anchor wiring ────────────────────────────────
		//
		// Hard guarantee: no content change may ever yank the user's scroll
		// position to the top. The scrollback filter above strips pi's
		// \x1b[3J, but other events can still move the viewport under the
		// user — a stray ED3 variant, a resize-trim clamp (fit() reflows and
		// can reduce ydisp to 0 when the buffer is near its limit), or
		// xterm's overflow content-following once the scrollback fills
		// (every recycled line decrements ydisp). While the user is scrolled
		// up, keep an xterm marker on the top-of-viewport line and restore
		// it after writes/resizes. User scrolls (wheel / scrollbar drag /
		// find navigation) re-anchor the marker and briefly suppress
		// restoration so their input is never fought. Ordinary scrolls —
		// including xterm's own content-following and the guard's own
		// restores — never re-anchor, so a bug-yank always shows up as
		// drift and is restored.
		//
		// xterm 6 scrolls through its custom `.xterm-scrollable-element`
		// (smooth custom scrollbar), NOT the legacy `.xterm-viewport` div —
		// wheel/mousedown land on the scrollable element and there are no
		// native DOM scroll events at all (the buffer moves via xterm's own
		// onScroll). Attach the user-input listeners where the events
		// actually happen; onScroll stands in for the DOM scroll event.
		const scrollSurface =
			container.querySelector(".xterm-scrollable-element") ??
			container.querySelector(".xterm-viewport");
		// Re-anchor on wheel (trackpad/mouse) — every notch is user intent.
		scrollSurface?.addEventListener("wheel", viewportAnchor.noteUserScroll, {
			passive: true,
		});
		// Re-anchor while a scrollbar drag is in progress (the drag moves the
		// viewport without wheel events).
		scrollSurface?.addEventListener("mousedown", viewportAnchor.beginDrag, {
			passive: true,
		});
		// The buffer is what actually scrolls in xterm 6; while a drag is in
		// progress every scroll event re-anchors so the anchor follows it.
		// Outside a drag this is a no-op, so programmatic moves (xterm's own
		// content-following, the guard's restores) never move the anchor.
		term.onScroll(viewportAnchor.viewportScrolled);
		// Release can happen anywhere (native scrollbar drags capture the
		// pointer; mouseleave fires mid-drag), so listen on the window.
		window.addEventListener("mouseup", viewportAnchor.endDrag);
		window.addEventListener("pointerup", viewportAnchor.endDrag);
		term.onWriteParsed(viewportAnchor.keepAnchored);
		term.onResize(viewportAnchor.keepAnchored);

		// Resize handling: observe the container AND the body — webview layout
		// changes (editor resize, sidebar toggles, tab switch) must re-fit.
		new ResizeObserver(() => {
			console.log("[CodePi-tui] ResizeObserver fired");
			reportSize();
		}).observe(container);
		new ResizeObserver(reportSize).observe(document.body);
		window.addEventListener("resize", () => {
			console.log(
				"[CodePi-tui] window.resize",
				window.innerWidth,
				"x",
				window.innerHeight,
			);
			scheduleFit();
		});

		console.log(
			"[CodePi-tui] init",
			window.innerWidth,
			"x",
			window.innerHeight,
			"container",
			container.clientWidth,
			"x",
			container.clientHeight,
		);

		// Watchdog: in some webview layouts the hosting iframe never delivers
		// resize events to its inner window, so the grid would keep its old size
		// with empty margins around it until the panel is recreated. Check the
		// container size every animation frame and refit only when it changed —
		// reportSize() no-ops when the grid didn't change, and the layout read
		// below is cheap when nothing is dirty. (rAF pauses when the panel is
		// hidden, matching suspend behavior.)
		let lastWatchW = -1;
		let lastWatchH = -1;
		(function frameLoop(): void {
			const w = container.clientWidth;
			const h = container.clientHeight;
			if (w !== lastWatchW || h !== lastWatchH) {
				lastWatchW = w;
				lastWatchH = h;
				reportSize();
			}
			requestAnimationFrame(frameLoop);
		})();

		// Refresh colors/background when the VS Code theme changes (theme switch
		// flips the <html> class, which this observer catches).
		const mo = new MutationObserver(() => {
			try {
				term.options.theme = readTheme();
				applyBackground();
			} catch {
				/* ignore */
			}
		});
		mo.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ["style", "class"],
		});

		// Focus the terminal when clicking anywhere on the container.
		container.addEventListener("mousedown", () => {
			// Clicks inside the find widget never reach here (its own mousedown
			// stops propagation); grid clicks refocus the terminal. When the
			// widget is open, xterm itself refocuses its textarea on grid
			// clicks — matching VS Code, where clicking the terminal while the
			// find box is open moves focus there and leaves the box open.
			if (!find.isOpen()) term.focus();
		});
		window.addEventListener("focus", () => {
			// Alt-tab back while the widget is open must not yank focus out of
			// the find input.
			if (!find.isOpen()) term.focus();
		});

		// Ctrl+F fallback: the custom key handler above only sees keystrokes
		// while xterm's textarea is focused; this catches the same chord when
		// focus sits on the webview body (e.g. right after panel creation).
		// open() is idempotent, so the double delivery (textarea case) is
		// harmless. Esc-close for the body-focus case is handled here too.
		document.addEventListener("keydown", (e: KeyboardEvent) => {
			if (find.isOpen()) {
				if (e.key === "Escape") {
					e.preventDefault();
					find.close();
				}
				return;
			}
			const ctrlLike = e.ctrlKey || e.metaKey;
			const isF = e.code === "KeyF" || e.key.toLowerCase() === "f";
			if (ctrlLike && isF) {
				e.preventDefault();
				find.open();
			}
		});

		// Announce readiness; the extension starts the TUI only after both ready
		// AND a size arrive, so the first frame renders at the real editor size.
		post({ command: "tuiReady", cols: term.cols, rows: term.rows });
		scheduleFit();

		// Safety net: if the font somehow still wasn't ready at open(), re-apply
		// the font options once it is. Reassigning fontFamily makes xterm
		// re-measure the cell grid AND rebuild the glyph atlas, so no tofu
		// persists; fit() then reflows to the real cell size.
		if (document.fonts?.ready) {
			document.fonts.ready
				.then(() => {
					try {
						term.options.fontFamily = FONT_FAMILY;
						term.options.fontSize = FONT_SIZE;
						term.refresh(0, term.rows - 1);
						scheduleFit();
					} catch {
						/* terminal disposed */
					}
				})
				.catch(() => undefined);
		}

		// Expose for debugging.
		(window as any).__codepiTerm = term;
	} catch (err) {
		fail(err instanceof Error ? err.message : String(err));
	}
})();
