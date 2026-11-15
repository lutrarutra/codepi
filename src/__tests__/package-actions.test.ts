import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as pi from "@earendil-works/pi-coding-agent";
import {
	listPackages,
	normalizePackageSource,
	runPackageAction,
	type PackageContext,
} from "../package-actions";

function setup(): { ctx: PackageContext; pkgDir: string; agentDir: string } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "codepi-pkg-"));
	const agentDir = path.join(root, "agent");
	const cwd = path.join(root, "project");
	const pkgDir = path.join(root, "my-pi-pkg");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(cwd, { recursive: true });
	fs.mkdirSync(path.join(pkgDir, "extensions"), { recursive: true });
	fs.writeFileSync(
		path.join(pkgDir, "package.json"),
		JSON.stringify({ name: "my-pi-pkg", version: "1.0.0", keywords: ["pi-package"] }),
	);
	fs.writeFileSync(path.join(pkgDir, "extensions/index.ts"), "export default function () {}\n");
	return { ctx: { cwd, agentDir, projectTrusted: false }, pkgDir, agentDir };
}

const settingsPackages = (agentDir: string): unknown[] =>
	JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8")).packages ?? [];

describe("pi package actions (real DefaultPackageManager, local package)", () => {
	it("installs into the user settings, lists, and removes", async () => {
		const { ctx, pkgDir, agentDir } = setup();
		expect(listPackages(pi, ctx)).toEqual([]);

		const installed = await runPackageAction(pi, ctx, { type: "install", source: pkgDir });
		expect(installed).toContain("Installed");
		expect(settingsPackages(agentDir)).toHaveLength(1);
		const listed = listPackages(pi, ctx);
		expect(listed).toHaveLength(1);
		expect(listed[0].scope).toBe("user");
		expect(listed[0].installed).toBe(true);

		const removed = await runPackageAction(pi, ctx, {
			type: "remove",
			source: listed[0].source,
			scope: "user",
		});
		expect(removed).toContain("Removed");
		expect(listPackages(pi, ctx)).toEqual([]);
	});

	it("reports a remove of a package that is not configured", async () => {
		const { ctx } = setup();
		const msg = await runPackageAction(pi, ctx, { type: "remove", source: "npm:not-there", scope: "user" });
		expect(msg).toContain("was not in the user settings");
	});

	it("rejects an empty or spaced source before touching settings", () => {
		expect(() => normalizePackageSource("   ")).toThrow(/Enter a package source/);
		expect(() => normalizePackageSource("npm:foo bar")).toThrow(/no spaces/);
		expect(normalizePackageSource("  npm:foo  ")).toBe("npm:foo");
	});
});
