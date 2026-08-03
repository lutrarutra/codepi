import { describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { probeExtensions } from "../extension-probe";

const FAKE_EXT = `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
	pi.registerCommand("fake-hello", {
		description: "A fixture command",
		handler: async () => {},
	});
	pi.registerTool({
		name: "fake_tool",
		label: "Fake Tool",
		description: "A fixture tool",
		parameters: {},
		execute: async () => ({ content: [] }),
	});
}
`;

describe("probeExtensions", () => {
	it("loads a fixture extension from the agent dir with its command and tool", async () => {
		const dir = join(tmpdir(), "codepi-probe-test-" + process.pid + "-" + Date.now());
		const extDir = join(dir, "extensions");
		mkdirSync(extDir, { recursive: true });
		writeFileSync(join(extDir, "fake-ext.ts"), FAKE_EXT);
		try {
			const result = await probeExtensions({
				cwd: dir,
				agentDir: dir,
				extensionResourcesDir: join(dir, "bundled"),
				readSettings: () => ({}),
			});
			const ext = result.extensions.find((e) =>
				(e.resolvedPath ?? e.path ?? "").endsWith("fake-ext.ts"),
			);
			expect(ext).toBeDefined();
			const commands = ext?.commands ? [...ext.commands.keys()] : [];
			const tools = ext?.tools ? [...ext.tools.keys()] : [];
			expect(commands).toContain("fake-hello");
			expect(tools).toContain("fake_tool");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
