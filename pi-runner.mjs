/**
 * PI agent runner — spawned as child process from extension.
 * Reads prompt from stdin JSON line, sends events to stdout as JSON lines.
 */
import * as path from "node:path";
import * as os from "node:os";
import * as readline from "node:readline";

const agentDir = path.join(os.homedir(), ".pi", "agent");
const cwd = process.env.CODEPI_CWD || process.cwd();

const pi = await import("@earendil-works/pi-coding-agent");
const authStorage = pi.AuthStorage.create(path.join(agentDir, "auth.json"));
const modelRegistry = pi.ModelRegistry.create(
	authStorage,
	path.join(agentDir, "models.json"),
);
const loader = new pi.DefaultResourceLoader({
	cwd,
	agentDir,
	extensionFactories: [],
});
await loader.reload();

const { session } = await pi.createAgentSession({
	resourceLoader: loader,
	cwd,
	agentDir,
	authStorage,
	modelRegistry,
	noTools: "builtin",
	sessionManager: pi.SessionManager.create(cwd),
});
if (!session.model) process.exit(1);

session.subscribe((event) => {
	if (event.type === "message_update") {
		const e = event.assistantMessageEvent;
		if (e.type === "text_delta" && "delta" in e) {
			process.stdout.write(JSON.stringify({ t: "text", d: e.delta }) + "\n");
		} else if (e.type === "thinking_delta" && "delta" in e) {
			process.stdout.write(
				JSON.stringify({ t: "thinking", d: e.delta }) + "\n",
			);
		} else if (e.type === "text_end") {
			process.stdout.write(JSON.stringify({ t: "text_end" }) + "\n");
		} else if (e.type === "thinking_end") {
			process.stdout.write(JSON.stringify({ t: "thinking_end" }) + "\n");
		} else if (e.type === "toolcall_start" && "toolCall" in e) {
			const tc = e.toolCall;
			process.stdout.write(
				JSON.stringify({
					t: "tool_start",
					id: tc.id,
					name: tc.name,
					args: tc.arguments || {},
				}) + "\n",
			);
		}
	} else if (event.type === "agent_end") {
		process.stdout.write(JSON.stringify({ t: "agent_end" }) + "\n");
	}
});

// Signal ready
process.stdout.write(JSON.stringify({ t: "ready" }) + "\n");

const rl = readline.createInterface({ input: process.stdin });
for await (const line of rl) {
	try {
		const msg = JSON.parse(line);
		if (msg.cmd === "prompt") {
			try {
				await session.prompt(msg.text);
				process.stdout.write(JSON.stringify({ t: "prompt_done" }) + "\n");
			} catch (e) {
				process.stdout.write(
					JSON.stringify({ t: "error", msg: String(e) }) + "\n",
				);
			}
		}
	} catch {
		/* ignore bad lines */
	}
}
session.dispose();
