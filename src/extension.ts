import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

// ── Lazy-load pi SDK (ESM-only, so we dynamic-import from CJS) ──────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _pi: any;

async function getPi() {
  if (!_pi) {
    _pi = await import("@earendil-works/pi-coding-agent");
  }
  return _pi;
}

let panel: vscode.WebviewPanel | undefined;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _agentSession: any;
let _cwd: string;
let _agentDir: string;

async function getOrCreateSession() {
  if (!_agentSession) {
    const pi = await getPi();

    // Use the user's existing pi config from ~/.pi/agent/
    const authStorage = pi.AuthStorage.create(path.join(_agentDir, "auth.json"));
    const modelRegistry = pi.ModelRegistry.create(authStorage, path.join(_agentDir, "models.json"));

    const result = await pi.createAgentSession({
      cwd: _cwd,
      agentDir: _agentDir,
      authStorage,
      modelRegistry,
      sessionManager: pi.SessionManager.inMemory(_cwd),
    });
    _agentSession = result.session;
  }
  return _agentSession;
}

// ── Sidebar WebviewViewProvider ──────────────────────────────────────────────

class CodePiSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "codepi.sidebarView";
  private _view?: vscode.WebviewView;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this._extensionUri, "webview-ui", "dist"),
      ],
    };

    webviewView.webview.html = buildHtml(
      this._extensionUri,
      webviewView.webview
    );

    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.command) {
        case "chat":
          await this._handleChat(message.text);
          break;
        case "getFileList":
          this._sendFileList();
          break;
      }
    });
  }

  private async _handleChat(text: string) {
    if (!this._view) return;
    try {
      const session = await getOrCreateSession();

      const unsubscribe = session.subscribe((event: any) => {
        if (event.type === "message_update") {
          if (event.assistantMessageEvent.type === "text_delta") {
            this._view?.webview.postMessage({
              command: "response",
              text: event.assistantMessageEvent.delta,
            });
          }
        }
        if (event.type === "message_end") {
          this._view?.webview.postMessage({ command: "responseEnd" });
        }
      });

      await session.prompt(text);
      unsubscribe();
    } catch (err: any) {
      _agentSession = undefined; // clear broken session so next message retries
      this._view?.webview.postMessage({
        command: "error",
        text: err.message || "Unknown error",
      });
    }
  }

  private _sendFileList() {
    if (!this._view) return;
    const ws = vscode.workspace.workspaceFolders;
    const files = ws ? readDirRecursive(ws[0].uri.fsPath, 0, 50) : [];
    this._view.webview.postMessage({ command: "fileList", files });
  }
}

// ── Activation ───────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
  // Resolve explicit paths (pi SDK needs these; defaults fail in extension host)
  _cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
  _agentDir = path.join(os.homedir(), ".pi", "agent");

  // Register sidebar view provider (Activity Bar button → sidebar)
  const sidebarProvider = new CodePiSidebarProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      CodePiSidebarProvider.viewType,
      sidebarProvider
    )
  );

  // Keep existing command (opens as editor panel)
  const disposable = vscode.commands.registerCommand(
    "codepi.openPanel",
    () => openPanel(context)
  );
  context.subscriptions.push(disposable);
}

// ── Webview Panel (editor tab) ───────────────────────────────────────────────

function openPanel(context: vscode.ExtensionContext) {
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
    }
  );

  panel.webview.html = buildHtml(context.extensionUri, panel.webview);

  panel.webview.onDidReceiveMessage(
    async (message) => {
      switch (message.command) {
        case "chat":
          await handleChatMessage(panel!.webview, message.text);
          break;
        case "getFileList":
          sendFileList(panel!);
          break;
      }
    },
    undefined,
    context.subscriptions
  );

  panel.onDidDispose(
    () => {
      panel = undefined;
    },
    undefined,
    context.subscriptions
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function handleChatMessage(
  webview: vscode.Webview,
  text: string
) {
  try {
    const session = await getOrCreateSession();

    const unsubscribe = session.subscribe((event: any) => {
      if (event.type === "message_update") {
        if (event.assistantMessageEvent.type === "text_delta") {
          webview.postMessage({
            command: "response",
            text: event.assistantMessageEvent.delta,
          });
        }
      }
      if (event.type === "message_end") {
        webview.postMessage({ command: "responseEnd" });
      }
    });

    await session.prompt(text);
    unsubscribe();
  } catch (err: any) {
    _agentSession = undefined; // clear broken session so next message retries
    webview.postMessage({
      command: "error",
      text: err.message || "Unknown error",
    });
  }
}

function sendFileList(p: vscode.WebviewPanel) {
  const ws = vscode.workspace.workspaceFolders;
  const files = ws ? readDirRecursive(ws[0].uri.fsPath, 0, 50) : [];
  p.webview.postMessage({ command: "fileList", files });
}

function readDirRecursive(dir: string, depth: number, max: number): string[] {
  if (depth > 2) return [];
  const result: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      result.push(full);
      if (result.length >= max) break;
      if (entry.isDirectory()) {
        result.push(...readDirRecursive(full, depth + 1, max - result.length));
      }
    }
  } catch {
    /* ignore */
  }
  return result.slice(0, max);
}

function buildHtml(
  extensionUri: vscode.Uri,
  webview: vscode.Webview
): string {
  const distUri = vscode.Uri.joinPath(extensionUri, "webview-ui", "dist");
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(distUri, "assets", "index.js")
  );
  const styleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(distUri, "assets", "index.css")
  );
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
  const possible =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

export function deactivate() {
  if (_agentSession) {
    _agentSession.dispose();
    _agentSession = undefined;
  }
}
