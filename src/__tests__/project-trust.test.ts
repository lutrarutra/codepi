import { beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { hasTrustRequiringProjectResources, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import {
	__resetProjectTrustForTests,
	projectTrustOptions,
	resolveProjectTrust,
	type ProjectTrustDeps,
	type TrustOption,
} from "../project-trust";

function tempProject(withPackages: boolean) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "codepi-trust-"));
	const project = path.join(root, "repo");
	fs.mkdirSync(path.join(project, ".pi"), { recursive: true });
	if (withPackages) {
		fs.writeFileSync(path.join(project, ".pi/settings.json"), JSON.stringify({ packages: ["npm:some-pkg"] }));
	}
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(agentDir);
	return { project, agentDir, root };
}

function deps(agentDir: string, over: Partial<ProjectTrustDeps> = {}): ProjectTrustDeps {
	return {
		hasTrustRequiringProjectResources,
		store: new ProjectTrustStore(agentDir),
		defaultProjectTrust: "ask",
		...over,
	};
}
const pick = (label: string) => async (_cwd: string, options: TrustOption[]) =>
	options.find((o) => o.label.startsWith(label));

beforeEach(() => __resetProjectTrustForTests());

describe("project trust for CodePi sessions", () => {
	it("trusts a folder without trust-requiring resources, without asking", async () => {
		const { project, agentDir } = tempProject(false);
		const ask = vi.fn();
		expect(await resolveProjectTrust(project, deps(agentDir, { ask }))).toBe(true);
		expect(ask).not.toHaveBeenCalled();
	});

	it("asks for a folder with project packages and saves 'Trust'", async () => {
		const { project, agentDir } = tempProject(true);
		const ask = vi.fn(pick("Trust"));
		expect(await resolveProjectTrust(project, deps(agentDir, { ask }))).toBe(true);
		expect(ask).toHaveBeenCalledTimes(1);
		expect(new ProjectTrustStore(agentDir).get(project)).toBe(true);
		// Saved: no second prompt.
		expect(await resolveProjectTrust(project, deps(agentDir, { ask }))).toBe(true);
		expect(ask).toHaveBeenCalledTimes(1);
	});

	it("'Do not trust' is saved and keeps the project resources out", async () => {
		const { project, agentDir } = tempProject(true);
		expect(await resolveProjectTrust(project, deps(agentDir, { ask: pick("Do not trust") }))).toBe(false);
		expect(new ProjectTrustStore(agentDir).get(project)).toBe(false);
	});

	it("session-only answers are not saved", async () => {
		const { project, agentDir } = tempProject(true);
		const ask = vi.fn(pick("Trust (this session only)"));
		expect(await resolveProjectTrust(project, deps(agentDir, { ask }))).toBe(true);
		expect(new ProjectTrustStore(agentDir).get(project)).toBeNull();
		expect(await resolveProjectTrust(project, deps(agentDir, { ask }))).toBe(true);
		expect(ask).toHaveBeenCalledTimes(1);
	});

	it("a dismissed prompt is untrusted and asks again next time", async () => {
		const { project, agentDir } = tempProject(true);
		const ask = vi.fn(async () => undefined);
		expect(await resolveProjectTrust(project, deps(agentDir, { ask }))).toBe(false);
		expect(await resolveProjectTrust(project, deps(agentDir, { ask }))).toBe(false);
		expect(ask).toHaveBeenCalledTimes(2);
	});

	it("follows defaultProjectTrust always / never without asking", async () => {
		const { project, agentDir } = tempProject(true);
		const ask = vi.fn();
		expect(await resolveProjectTrust(project, deps(agentDir, { ask, defaultProjectTrust: "always" }))).toBe(true);
		expect(await resolveProjectTrust(project, deps(agentDir, { ask, defaultProjectTrust: "never" }))).toBe(false);
		expect(ask).not.toHaveBeenCalled();
	});

	it("without a prompt (Extensions view probe) an undecided folder is untrusted", async () => {
		const { project, agentDir } = tempProject(true);
		expect(await resolveProjectTrust(project, deps(agentDir))).toBe(false);
	});

	it("'Trust parent folder' covers the folder through the nearest saved entry", async () => {
		const { project, agentDir, root } = tempProject(true);
		await resolveProjectTrust(project, deps(agentDir, { ask: pick("Trust parent folder") }));
		const store = new ProjectTrustStore(agentDir);
		expect(store.get(project)).toBe(true);
		expect(store.getEntry(project)?.path).toBe(fs.realpathSync(root));
	});

	it("offers pi's five choices in pi's order", () => {
		expect(projectTrustOptions("/work/repo").map((o) => o.label)).toEqual([
			"Trust",
			"Trust parent folder (/work)",
			"Trust (this session only)",
			"Do not trust",
			"Do not trust (this session only)",
		]);
	});
});
