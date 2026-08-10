/**
 * Pure filesystem core for the sessions sidebar's pinned-sessions store.
 * NO vscode imports — unit-testable (same pattern as pi-store.ts).
 *
 * The store is a small JSON file — an array of absolute session paths — kept
 * inside the CodePi sessions directory (…/globalStorage/…/sessions/pinned.json).
 * It deliberately lives OUTSIDE the session files themselves:
 *
 *  - reading it costs one tiny parse per list refresh, instead of a second
 *    streaming scan of every session JSONL (they can be megabytes);
 *  - pin/unpin never appends to a session file that may be live in an open
 *    TUI tab (the sidebar's rename already accepts that concurrency caveat;
 *    pinning doesn't need to);
 *  - deleting a session removes its pin key, and stale keys for sessions
 *    deleted outside the sidebar are harmless (join by path).
 *
 * Sessions dir discovery only picks up *.jsonl files, so this file is never
 * mistaken for a session.
 */
import { existsSync, readFileSync } from "node:fs";
import { writeJsonFileAtomic } from "./pi-store";

/**
 * Read the pinned session paths. Tolerant of a missing or malformed store:
 * both yield an empty list (the next write repairs the file).
 */
export function readPinnedSessionPaths(storePath: string): string[] {
	if (!existsSync(storePath)) return [];
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(storePath, "utf8"));
	} catch {
		return [];
	}
	if (!Array.isArray(raw)) return [];
	return [...new Set(raw.filter((p): p is string => typeof p === "string"))];
}

/**
 * Mark a session pinned or unpinned. No-op (no write) when the state is
 * already as requested. Returns the updated path list.
 */
export function setSessionPinned(
	storePath: string,
	sessionPath: string,
	pinned: boolean,
): string[] {
	const paths = readPinnedSessionPaths(storePath);
	const wasPinned = paths.includes(sessionPath);
	if (wasPinned === pinned) return paths; // state unchanged — no write
	const next = pinned
		? [...paths.filter((p) => p !== sessionPath), sessionPath]
		: paths.filter((p) => p !== sessionPath);
	writeJsonFileAtomic(storePath, next);
	return next;
}

/** Forget a deleted session's pin. No-op when the path was never pinned. */
export function removePinnedSessionPath(
	storePath: string,
	sessionPath: string,
): void {
	const paths = readPinnedSessionPaths(storePath);
	const next = paths.filter((p) => p !== sessionPath);
	if (next.length === paths.length) return;
	writeJsonFileAtomic(storePath, next);
}
