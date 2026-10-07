/**
 * Guard the .vscodeignore node_modules allowlist against package-lock.json.
 *
 * The extension host imports pi's SDK at runtime, and the SDK is not bundled
 * (esbuild externalizes it), so the shipped .vsix must contain pi's whole
 * production dependency closure. pi 1.0 hoisted that closure to the root
 * node_modules, which means every package needs its own `!node_modules/...`
 * allowlist rule — an omitted package produces a vsix that dies at activation
 * with "Cannot find package ..." (exactly what happened when the pi 1.0.4 bump
 * first dropped 131 of 148 packages).
 *
 * This test recomputes the closure from the lockfile and asserts that the
 * allowlist covers it exactly: nothing missing, nothing stale, and no dev-only
 * package riding along.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(__dirname, "..", "..");
const NODE_MODULES = join(ROOT, "node_modules");
const NODE_MODULES_REL = "node_modules";

interface LockEntry {
	dev?: boolean;
	dependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
}

const packages = (
	JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8")) as {
		packages: Record<string, LockEntry>;
	}
).packages;

/** Node resolution over the lockfile's install paths. */
function resolveFrom(name: string, fromDir: string): string | undefined {
	const parts = fromDir === "" ? [] : fromDir.split("/");
	for (;;) {
		const candidate = [...parts, "node_modules", name].join("/");
		if (candidate in packages) return candidate;
		if (parts.length === 0) return undefined;
		parts.pop();
	}
}

/** Every package reachable from the root's production dependencies. */
function productionClosure(): Set<string> {
	const root = packages[""] ?? {};
	const queue: string[] = [];
	for (const name of [
		...Object.keys(root.dependencies ?? {}),
		...Object.keys(root.optionalDependencies ?? {}),
	]) {
		const path = resolveFrom(name, "");
		if (path) queue.push(path);
	}
	const seen = new Set<string>();
	while (queue.length > 0) {
		const path = queue.pop() as string;
		if (seen.has(path)) continue;
		seen.add(path);
		const entry = packages[path];
		if (!entry || entry.dev) continue;
		for (const name of [
			...Object.keys(entry.dependencies ?? {}),
			...Object.keys(entry.optionalDependencies ?? {}),
		]) {
			const next = resolveFrom(name, path);
			if (next) queue.push(next);
		}
	}
	return seen;
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/** Top-level `node_modules/<pkg>` dirs that exist on disk, scopes included. */
function installedTopLevelPackages(): string[] {
	const found: string[] = [];
	const walk = (dir: string, prefix: string) => {
		for (const entry of readdirSync(dir)) {
			if (entry.startsWith(".")) continue;
			const rel = prefix === "" ? entry : `${prefix}/${entry}`;
			if (prefix === "" && entry.startsWith("@")) {
				walk(join(dir, entry), entry);
				continue;
			}
			if (!isDirectory(join(dir, entry))) continue;
			found.push(`${NODE_MODULES_REL}/${rel}`);
		}
	};
	walk(NODE_MODULES, "");
	return found;
}

/** Allowlist patterns from .vscodeignore, as the package dir they un-ignore. */
function allowlistedPrefixes(): { pattern: string; prefix: string }[] {
	return readFileSync(join(ROOT, ".vscodeignore"), "utf8")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.startsWith("!node_modules/"))
		.map((pattern) => ({
			pattern,
			prefix: pattern.slice(1).replace(/\/\*\*$/, ""),
		}));
}

const closure = productionClosure();
const installed = installedTopLevelPackages();
const patterns = allowlistedPrefixes();

/**
 * A package ships either because it is itself in the closure, or because it is
 * nested inside a closure package (nested installs travel with their parent,
 * which the parent's allowlist rule covers).
 */
const isProduction = (dir: string): boolean =>
	closure.has(dir) ||
	[...closure].some((path) => path.startsWith(`${dir}/`));

const isAllowed = (dir: string): boolean =>
	patterns.some(
		({ prefix }) => dir === prefix || dir.startsWith(`${prefix}/`),
	);

describe("packaging: .vscodeignore node_modules allowlist", () => {
	it("has a lockfile and an allowlist to compare", () => {
		expect(installed.length).toBeGreaterThan(50);
		expect(patterns.length).toBeGreaterThan(50);
	});

	it("allow-lists every installed production package", () => {
		const missing = installed
			.filter((dir) => isProduction(dir))
			.filter((dir) => !isAllowed(dir));
		expect(missing).toEqual([]);
	});

	it("does not ship dev-only packages", () => {
		const leaked = installed.filter(
			(dir) => isAllowed(dir) && !isProduction(dir),
		);
		expect(leaked).toEqual([]);
	});

	it("has no stale allowlist rule", () => {
		// A rule may target a package (`node_modules/typebox`) or a whole scope
		// (`node_modules/@babel`), so match it against the installed dirs either
		// way.
		const stale = patterns
			.filter(
				({ prefix }) =>
					!installed.some(
						(dir) => dir === prefix || dir.startsWith(`${prefix}/`),
					),
			)
			.map(({ pattern }) => pattern);
		expect(stale).toEqual([]);
	});

	it("ships the SDK entry points the extension host requires", () => {
		for (const dir of [
			"node_modules/@earendil-works/pi-coding-agent",
			"node_modules/@earendil-works/pi-tui",
			"node_modules/@earendil-works/pi-agent-core",
			"node_modules/typebox",
		]) {
			expect(existsSync(join(ROOT, dir))).toBe(true);
			expect(isAllowed(dir)).toBe(true);
		}
	});
});
