import { describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getCodePiSessionDir, getCanonicalAgentDir } from "../pi-store";
import {
	buildDashboardData,
	getDashboardFileStatus,
	mapConfiguredPackageStatus,
} from "../settings-dashboard";
import type {
	DashboardData,
	SettingsMessage,
	SettingsReply,
} from "../shared/settings-protocol";

describe("settings dashboard protocol", () => {
	it("describes paths and resource status without credential values", () => {
		const data: DashboardData = buildDashboardData(
			getCanonicalAgentDir(),
			getCodePiSessionDir("/vscode/codepi"),
			{},
			[{ source: "npm:example", scope: "user", installed: true }],
			{ settings: true, models: false, auth: true },
		);

		expect(JSON.stringify(data)).not.toContain("sk-");
		expect(JSON.stringify(data)).not.toContain("token");
		expect(data.bundledResources).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "custom-footer", enabled: true }),
			]),
		);
	});

	it("maps configured package paths to installed and missing status", () => {
		const packages = mapConfiguredPackageStatus([
			{
				source: "npm:installed",
				scope: "user",
				installedPath: "/pi/agent/npm/node_modules/installed",
			},
			{ source: "git:example/missing", scope: "project" },
		]);

		expect(packages).toEqual([
			{
				source: "npm:installed",
				scope: "user",
				installed: true,
			},
			{
				source: "git:example/missing",
				scope: "project",
				installed: false,
			},
		]);
		const dashboard = buildDashboardData(
			"/home/user/.pi/agent",
			"/vscode/codepi/sessions",
			{},
			packages,
		);
		expect(dashboard.packages).toMatchObject({
			configured: 2,
			installed: 1,
			missing: 1,
		});
		expect(dashboard.packages.entries).toEqual(packages);
	});

	it("uses auth metadata without reading or parsing auth.json", () => {
		const dir = join(
			tmpdir(),
			`codepi-dashboard-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		mkdirSync(dir, { recursive: true });
		try {
			writeFileSync(join(dir, "auth.json"), "not-json");
			expect(getDashboardFileStatus(dir)).toEqual({
				settings: false,
				models: false,
				auth: true,
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("defines only stable dashboard commands", () => {
		const messages: SettingsMessage[] = [
			{ command: "settings:get" },
			{
				command: "settings:setBundledResource",
				id: "filechanges",
				enabled: false,
			},
			{ command: "settings:openFile", file: "auth" },
			{ command: "settings:refresh" },
			{ command: "settings:openSessions" },
		];
		expect(messages).toHaveLength(5);
		const reply: SettingsReply = {
			command: "settings:saved",
			ok: true,
			resource: "filechanges",
		};
		expect(reply.command).toBe("settings:saved");
	});
});
