/**
 * Extension-side helpers for Ctrl+click terminal links (the webview posts a
 * `codepi:openLink` message; these functions turn the payload into a local
 * file path to open).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Shape of a link activation posted by the terminal webview. */
export interface CodePiOpenLinkPayload {
	kind: "word" | "url" | "file";
	/** Full underlined text (may include a :line[:col] suffix). */
	text: string;
	/** kind === "url": the URL to open externally. */
	url?: string;
	/** kind === "file": the path (without the line/col suffix). */
	path?: string;
	/** 1-based line, when the link carried a suffix. */
	line?: number;
	/** 1-based column, when present. */
	column?: number;
}

/**
 * Classify a Ctrl+clicked word as a URL. Mirrors VS Code's scheme matching
 * (LinkComputer + matchesScheme): any `scheme://` token (http, https, file,
 * ssh, git, …) or a `mailto:` target. A Windows path like `C:\foo` is NOT a
 * URL (no `://`), so it falls through to file resolution.
 */
export function classifyAsUrl(text: string): { scheme: string } | undefined {
	const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(text);
	if (m) {
		return { scheme: m[1].toLowerCase() };
	}
	if (/^mailto:/i.test(text)) {
		return { scheme: "mailto" };
	}
	return undefined;
}

/**
 * Split a trailing `:line` / `:line:col` suffix off a word. Mirrors the
 * suffix handling in TerminalSearchLinkOpener (file:10:5 → file, line 10,
 * col 5); words without a numeric suffix are returned whole.
 */
export function splitLineColumn(text: string): {
	path: string;
	line?: number;
	column?: number;
} {
	const m = /^(.*?):(\d+)(?::(\d+))?$/.exec(text);
	if (m) {
		return {
			path: m[1],
			line: parseInt(m[2], 10),
			column: m[3] !== undefined ? parseInt(m[3], 10) : undefined,
		};
	}
	return { path: text };
}

/**
 * Normalize a word before file resolution, ported from
 * TerminalSearchLinkOpener.open: strip a `file://` prefix, `:<non-number>`
 * tails (Ruby stack traces like `link:in ...`), and a trailing period.
 */
export function normalizeSearchText(text: string): string {
	// Strip only `file://` (2 slashes) so `file:///home/x` keeps its leading
	// `/` and stays an absolute path for resolveTerminalFilePath.
	let t = text.replace(/^file:\/\//, "");
	t = t.replace(/:[^\\/\d][^\d]*$/, "");
	t = t.replace(/\.$/, "");
	return t;
}

/** Escape glob metacharacters for workspace.findFiles patterns. */
export function escapeGlob(text: string): string {
	return text.replace(/[*?[\]{}()]/g, "\\$&");
}

/**
 * Resolve a terminal file link to an existing path on disk.
 *
 * Mirrors VS Code's TerminalLocalFileLinkOpener/TerminalSearchLinkOpener
 * resolution order: absolute paths are used as-is, relative paths are tried
 * against the session cwd and then the workspace folders, `~` is expanded,
 * and `file://` prefixes are stripped.
 *
 * @returns the first existing candidate path, or undefined when nothing on
 * disk matches.
 */
export function resolveTerminalFilePath(
	rawPath: string,
	cwd: string,
	workspaceFolders: string[],
): string | undefined {
	let p = rawPath.trim();
	if (!p) return undefined;

	// Strip a file:// prefix (file:///home/x → /home/x).
	if (p.startsWith("file://")) {
		p = p.replace(/^file:\/\//, "");
	}

	// Expand ~ to the home directory.
	if (p === "~") {
		p = os.homedir();
	} else if (p.startsWith("~/")) {
		p = path.join(os.homedir(), p.slice(2));
	}

	const candidates: string[] = [];
	if (path.isAbsolute(p)) {
		candidates.push(path.normalize(p));
	} else {
		for (const base of [cwd, ...workspaceFolders]) {
			candidates.push(path.join(base, p));
		}
	}

	for (const candidate of candidates) {
		if (fs.existsSync(candidate)) {
			return candidate;
		}
	}
	return undefined;
}
