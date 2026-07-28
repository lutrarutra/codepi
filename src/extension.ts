import * as vscode from "vscode";
import { createMcpServer } from "./mcp/server";
import { registerCoreTools } from "./mcp/tools/index";
import { createAgentRuntime } from "./agent/runtime";
import { PiEventRelay } from "./bridge/relay";
import type { WebviewMessage } from "./bridge/protocol";

let panel: vscode.WebviewPanel | undefined;
let mcpServer: ReturnType<typeof createMcpServer> | undefined;
let agentRuntime: Awaited<ReturnType<typeof createAgentRuntime>> | undefined;
const relay = new PiEventRelay();

export function activate(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand("codepi.openPanel", () => {
    if (panel) {
      panel.reveal(vscode.ViewColumn.Two);
      return;
    }

    panel = vscode.window.createWebviewPanel(
      "codepi",
      "CodePi",
      vscode.ViewColumn.Two,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, "webview-ui", "dist"),
        ],
      },
    );

    panel.webview.html = buildHtml(context.extensionUri, panel.webview);
    relay.setWebview(panel.webview);

    panel.webview.onDidReceiveMessage(
      async (message: WebviewMessage) => {
        await handleWebviewMessage(message).catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          panel?.webview.postMessage({ command: "error", text: msg });
        });
      },
      undefined,
      context.subscriptions,
    );

    panel.onDidDispose(
      async () => {
        panel = undefined;
        relay.setWebview(undefined as unknown as vscode.Webview);
        await agentRuntime?.dispose();
        agentRuntime = undefined;
        await mcpServer?.stop();
        mcpServer = undefined;
      },
      undefined,
      context.subscriptions,
    );

    startBackend();
  });

  context.subscriptions.push(disposable);
}

async function startBackend(): Promise<void> {
  try {
    mcpServer = createMcpServer();
    registerCoreTools(mcpServer);
    await mcpServer.start();
    console.log(`[CodePi] MCP server listening on port ${mcpServer.port}`);

    agentRuntime = await createAgentRuntime(mcpServer, relay);
    console.log("[CodePi] Agent runtime ready");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    panel?.webview.postMessage({ command: "error", text: msg });
    console.error("[CodePi] Backend start failed:", err);
  }
}

async function handleWebviewMessage(message: WebviewMessage): Promise<void> {
  if (!agentRuntime) return;

  switch (message.command) {
    case "prompt":
      await agentRuntime.session.prompt(message.text);
      break;
    case "steer":
      await agentRuntime.session.steer(message.text);
      break;
    case "followUp":
      await agentRuntime.session.followUp(message.text);
      break;
    case "abort":
      await agentRuntime.session.abort();
      break;
  }
}

function buildHtml(extensionUri: vscode.Uri, webview: vscode.Webview): string {
  const distUri = vscode.Uri.joinPath(extensionUri, "webview-ui", "dist");
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, "assets", "index.js"));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, "assets", "index.css"));
  const nonce = getNonce();

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>CodePi</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function getNonce(): string {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

export function deactivate() {
  agentRuntime?.dispose();
  mcpServer?.stop();
}
