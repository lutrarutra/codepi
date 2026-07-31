import * as vscode from "vscode";
import * as path from "node:path";
import * as os from "node:os";
import { getAgentDir, importLegacyConfig } from "./pi-store";

/**
 * Interactive import flow for the settings GUI and the palette command.
 * Offers ~/.pi (config+sessions or config only) or a user-picked folder.
 * Returns the imported file list, or undefined when cancelled.
 */
export async function runImportFlow(): Promise<{ imported: string[] } | undefined> {
	const defaultDir = path.join(os.homedir(), ".pi", "agent");
	const choice = await vscode.window.showQuickPick(
		[
			{ label: "Import from ~/.pi (config + sessions)", detail: "Copy settings.json, auth.json, models.json and the sessions/ folder" },
			{ label: "Import from ~/.pi (config only)", detail: "Copy settings.json, auth.json, models.json" },
			{ label: "Import from another folder (config + sessions)…", detail: "Pick a directory containing a pi agent config" },
			{ label: "Import from another folder (config only)…", detail: "Pick a directory containing settings.json / auth.json / models.json" },
		],
		{ placeHolder: "Import pi configuration into CodePi's storage" },
	);
	if (!choice) return undefined;

	let source = defaultDir;
	let includeSessions = false;
	if (choice.label.startsWith("Import from ~/.pi (config + sessions)")) {
		includeSessions = true;
	} else if (choice.label.startsWith("Import from ~/.pi (config only)")) {
		/* defaults */
	} else {
		const picked = await vscode.window.showOpenDialog({
			canSelectFiles: false,
			canSelectFolders: true,
			canSelectMany: false,
			openLabel: "Select config folder",
			title: "Select a folder containing pi config (settings.json / auth.json / models.json)",
			defaultUri: vscode.Uri.file(defaultDir),
		});
		if (!picked || picked.length === 0) return undefined;
		source = picked[0].fsPath;
		includeSessions = choice.label.includes("config + sessions");
	}

	return importLegacyConfig(source, getAgentDir(), { includeSessions });
}
