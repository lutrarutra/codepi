import * as path from "node:path";
import * as os from "node:os";
import * as vscode from "vscode";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { discoverMcpTools, callMcpTool } from "./tool-registry";
import type { McpServer } from "../mcp/server";
import type { PiEventRelay } from "../bridge/relay";

// Lazy import — pi SDK is ESM-only, must use dynamic import from CJS bundle
let _pi: any;
async function getPi(): Promise<any> {
	if (!_pi) {
		_pi = await import("@earendil-works/pi-coding-agent");
	}
	return _pi;
}

export async function createAgentRuntime(
	mcpServer: McpServer,
	relay: PiEventRelay,
): Promise<{ session: AgentSession; dispose(): Promise<void> }> {
	const pi = await getPi();
	const workspaceRoot = getWorkspaceRoot();
	const agentDir = path.join(os.homedir(), ".pi", "agent");

	const authStorage = pi.AuthStorage.create(path.join(agentDir, "auth.json"));
	const modelRegistry = pi.ModelRegistry.create(
		authStorage,
		path.join(agentDir, "models.json"),
	);

	const mcpBridgeExtension: ExtensionFactory = (extPi) => {
		discoverMcpTools(mcpServer.port)
			.then((tools) => {
				for (const tool of tools) {
					extPi.registerTool({
						name: tool.name,
						label: tool.name,
						description: tool.description,
						parameters: tool.inputSchema as any,
						async execute(_toolCallId, params) {
							const result = await callMcpTool(
								mcpServer.port,
								tool.name,
								params as Record<string, unknown>,
							);
							return { ...result, details: {} };
						},
					});
				}
			})
			.catch((err: Error) => {
				console.error("[CodePi] MCP tool discovery failed:", err);
			});
	};

	const loader = new pi.DefaultResourceLoader({
		cwd: workspaceRoot,
		agentDir,
		extensionFactories: [mcpBridgeExtension],
	});
	await loader.reload();

	const { session } = await pi.createAgentSession({
		resourceLoader: loader,
		cwd: workspaceRoot,
		agentDir,
		authStorage,
		modelRegistry,
		noTools: "builtin",
		sessionManager: pi.SessionManager.create(workspaceRoot),
	});

	relay.attach(session);

	return {
		session,
		async dispose() {
			relay.detach();
			session.dispose();
		},
	};
}

function getWorkspaceRoot(): string {
	const ws = vscode.workspace.workspaceFolders?.[0];
	return ws?.uri.fsPath ?? os.homedir();
}
