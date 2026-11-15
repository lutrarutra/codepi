import type { Terminal } from "@xterm/xterm";
import "./jump.css";

/**
 * "Jump to latest" button: visible while the viewport is above the bottom,
 * highlighted once new output arrives below it. xterm only follows output
 * while the viewport is exactly at the last line, so without it a reader who
 * stopped a few lines short (or scrolled up to read) sees no sign that pi is
 * still writing.
 */
export interface JumpButton {
	/** Re-evaluate visibility (after scrolls and writes; rAF-throttled). */
	update: () => void;
}

export function createJumpButton(
	term: Terminal,
	container: HTMLElement,
	jump: () => void,
): JumpButton {
	const button = document.createElement("button");
	button.type = "button";
	button.className = "codepi-jump";
	button.title = "Jump to the latest output";
	button.setAttribute("aria-label", "Jump to the latest output");
	button.textContent = "↓ Latest";
	button.hidden = true;
	// Keep the click from reaching the container's mousedown (focus/drag logic).
	button.addEventListener("mousedown", (e) => e.stopPropagation());
	button.addEventListener("click", (e) => {
		e.preventDefault();
		jump();
	});
	container.appendChild(button);

	let scheduled = false;
	let seenLength = -1; // buffer length when the reader left the bottom

	const apply = (): void => {
		scheduled = false;
		const b = term.buffer.active;
		const away = b.viewportY < b.baseY;
		if (!away) {
			seenLength = -1;
			button.hidden = true;
			button.classList.remove("codepi-jump-new");
			return;
		}
		if (seenLength < 0) seenLength = b.length;
		button.hidden = false;
		button.classList.toggle("codepi-jump-new", b.length > seenLength);
	};

	return {
		update(): void {
			if (scheduled) return;
			scheduled = true;
			requestAnimationFrame(apply);
		},
	};
}
