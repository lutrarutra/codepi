import * as cp from "node:child_process";
import * as vscode from "vscode";
import type { ExtensionMessage } from "../bridge/protocol";

/**
 * Session-like interface for child process runner.
 */
export interface ChildSession {
	prompt(text: string): Promise<void>;
	abort(): Promise<void>;
	steer(text: string): Promise<void>;
	followUp(text: string): Promise<void>;
	readonly isStreaming: boolean;
}

export function createChildAgentRuntime(
	relay: { postMessageSilent(msg: ExtensionMessage): void },
	context: vscode.ExtensionContext,
): { session: ChildSession; dispose(): Promise<void> } {
	const runnerPath = context.asAbsolutePath("pi-runner.mjs");
	const nodeBin = process.execPath;

	console.log("[CodePi] Spawning child agent:", runnerPath);

	const child = cp.spawn(nodeBin, [runnerPath], {
		stdio: ["pipe", "pipe", "pipe", "pipe"],
		cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
		env: {
			...process.env,
			CODEPI_CWD: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "",
		},
	});

	child.stderr?.on("data", (d: Buffer) => {
		process.stderr.write("[CodePi child] " + d.toString());
	});

	child.stdio[3]?.on("data", (d: Buffer) => {
		for (const line of d.toString().split("\n").filter(Boolean)) {
			console.log("[CodePi child]", line);
		}
	});

	child.stdout?.on("data", (data: Buffer) => {
		const lines = data.toString().split("\n").filter(Boolean);
		for (const line of lines) {
			try {
				const msg = JSON.parse(line);
				switch (msg.t) {
					case "thinking":
						relay.postMessageSilent({
							command: "thinkingDelta",
							delta: msg.d,
						});
						break;
					case "text":
						relay.postMessageSilent({
							command: "textDelta",
							delta: msg.d,
						});
						break;
					case "thinking_end":
						relay.postMessageSilent({ command: "thinkingEnd" });
						break;
					case "text_end":
						relay.postMessageSilent({ command: "textEnd" });
						break;
					case "tool_start":
						relay.postMessageSilent({
							command: "toolCallStart",
							toolCallId: msg.id,
							toolName: msg.name,
							args: msg.args,
						});
						break;
					case "agent_end":
						relay.postMessageSilent({
							command: "agentEnd",
							willRetry: false,
						});
						break;
					case "error":
						relay.postMessageSilent({
							command: "error",
							text: msg.msg,
						});
						break;
				}
			} catch {
				console.log("[CodePi child] stdout:", line.slice(0, 200));
			}
		}
	});

	child.on("exit", (code) => {
		console.log("[CodePi] Child process exited:", code);
	});

	// Wait for ready signal from child
	let childReady = false;
	const readyTimeout = setTimeout(() => {
		console.warn("[CodePi] Child process didn't signal ready");
		childReady = true; // Continue anyway
	}, 30000);
	const readyListener = (data: Buffer) => {
		if (data.toString().includes('"ready"')) {
			childReady = true;
			clearTimeout(readyTimeout);
			child.stdout?.removeListener("data", readyListener);
			console.log("[CodePi] Child process ready");
		}
	};
	child.stdout?.on("data", readyListener);

	let _streaming = false;

	function sendPrompt(text: string): Promise<void> {
		if (!childReady) {
			return Promise.reject(new Error("Child not ready yet"));
		}
		_streaming = true;
		relay.postMessageSilent({ command: "agentStart" });
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				_streaming = false;
				reject(new Error("Prompt timed out"));
			}, 120_000);

			const listener = (data: Buffer) => {
				const raw = data.toString();
				if (raw.includes('"prompt_done"')) {
					_streaming = false;
					clearTimeout(timeout);
					child.stdout?.removeListener("data", listener);
					resolve();
					return;
				}
				if (
					raw.includes('"error"') &&
					raw.includes('"msg"') &&
					!raw.includes('"text_delta"')
				) {
					try {
						const lines = raw.split("\n").filter(Boolean);
						const last = JSON.parse(lines[lines.length - 1]);
						if (last.t === "error") {
							_streaming = false;
							clearTimeout(timeout);
							child.stdout?.removeListener("data", listener);
							reject(new Error(last.msg));
							return;
						}
					} catch {
						/* ignore */
					}
				}
			};
			child.stdout?.on("data", listener);

			child.stdin?.write(JSON.stringify({ cmd: "prompt", text }) + "\n");
		});
	}

	return {
		session: {
			get isStreaming() {
				return _streaming;
			},
			prompt(text: string) {
				return sendPrompt(text);
			},
			abort() {
				try {
					child.kill();
				} catch {
					/* ignore */
				}
				return Promise.resolve();
			},
			steer(text: string) {
				return sendPrompt(text);
			},
			followUp(text: string) {
				return sendPrompt(text);
			},
		},
		async dispose() {
			try {
				child.kill();
			} catch {
				/* ignore */
			}
		},
	};
}
