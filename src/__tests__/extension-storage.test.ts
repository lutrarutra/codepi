import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * These source-level assertions protect the session storage contract without
 * importing the VS Code extension host into Vitest.
 */
describe("CodePi session storage routing", () => {
	it("passes an explicit session directory to every persistent SessionManager call", () => {
		const extension = readFileSync(
			join(process.cwd(), "src", "extension.ts"),
			"utf8",
		);
		const tree = readFileSync(
			join(process.cwd(), "src", "views", "session-tree.ts"),
			"utf8",
		);

		expect(extension).not.toMatch(/SessionManager\.listAll\(\s*\)/);
		expect(extension).toContain("getCodePiSessionDir(context.globalStorageUri.fsPath)");
		expect(extension).toContain("SessionManager.create(\n\t\tworkspaceRoot,\n\t\tgetCodePiSessionDirForRuntime(),");
		expect(extension).toContain("SessionManager.listAll(\n\t\t\tgetCodePiSessionDirForRuntime(),");
		expect(tree).toContain("SessionManager.list(this.cwd, this.sessionDir)");
		expect(tree).toContain("SessionManager.open(sessionPath, this.sessionDir)");
	});
});
