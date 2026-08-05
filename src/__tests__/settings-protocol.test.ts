import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	ASK_MODE_DEFAULT_ALLOWED_TOOLS,
	getCodePiSessionDir,
	getCanonicalAgentDir,
} from "../pi-store";
import {
	buildDashboardData,
	collectConfiguredPackageStatus,
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
			{ codepi: { fontFamily: "Menlo", fontSize: 16 } },
			[{ source: "npm:example", scope: "user", installed: true }],
			{ settings: true, models: false, auth: true },
		);

		expect(JSON.stringify(data)).not.toMatch(/sk-[A-Za-z0-9_-]{8,}/);
		expect(JSON.stringify(data)).not.toContain("token");
		expect(data.terminalPrefs).toEqual({ fontFamily: "Menlo", fontSize: 16 });
		expect(data.autoVerify).toBe("nextTurn");
		// Missing settings block → effective defaults are reported for display.
		expect(data.askAllowedTools).toEqual([...ASK_MODE_DEFAULT_ALLOWED_TOOLS]);
		expect(data.bundledResources).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "codepi-footer", enabled: true }),
			]),
		);
	});

	it("collects package status from a fake agent without installing packages", async () => {
		const agentDir = join(
			tmpdir(),
			`codepi-package-status-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		const cwd = join(agentDir, "workspace");
		mkdirSync(join(agentDir, "npm", "node_modules", "installed"), {
			recursive: true,
		});
		mkdirSync(cwd, { recursive: true });
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ packages: ["npm:installed", "npm:missing"] }),
		);
		try {
			const sdk = await import("@earendil-works/pi-coding-agent");
			const packages = collectConfiguredPackageStatus(sdk, cwd, agentDir);
			expect(packages).toEqual([
				{ source: "npm:installed", scope: "user", installed: true },
				{ source: "npm:missing", scope: "user", installed: false },
			]);
			expect(
				packages
					.filter((entry) => !entry.installed)
					.map((entry) => entry.source),
			).toEqual(["npm:missing"]);
			expect(existsSync(join(agentDir, "npm", "node_modules", "missing"))).toBe(
				false,
			);
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
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
		expect(dashboard.autoVerify).toBe("nextTurn");
		expect(
			buildDashboardData("/x", "/y", { codepi: { autoVerify: "followUp" } }, [])
				.autoVerify,
		).toBe("followUp");
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
				id: "codepi-diff",
				enabled: false,
			},
			{
				command: "settings:setTerminalPrefs",
				fontFamily: "Menlo",
				fontSize: 15,
			},
			{ command: "settings:setAutoVerify", mode: "nextTurn" },
			{ command: "settings:openFile", file: "auth" },
			{ command: "settings:refresh" },
			{ command: "settings:openSessions" },
		];
		expect(messages).toHaveLength(7);
		const reply: SettingsReply = {
			command: "settings:saved",
			ok: true,
			resource: "autoVerify",
		};
		expect(reply.command).toBe("settings:saved");
	});
});
