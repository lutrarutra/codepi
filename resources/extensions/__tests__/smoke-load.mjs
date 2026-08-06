// Smoke test: compile + execute the bundled extension factories through jiti
// (the same loader pi uses at runtime) against a mock pi API.
import { createJiti } from "../../../node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { join } from "node:path";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const require = createRequire(import.meta.url);

// Mirror the alias map pi's extension loader uses (loader.ts getAliases), so
// jiti resolves the @earendil-works packages and typebox the same way at
// runtime. resolve() walks up from the coding-agent package for nested deps.
const resolveFromPi = (specifier) =>
	require.resolve(specifier, {
		paths: [join(root, "node_modules", "@earendil-works", "pi-coding-agent")],
	});
const nestedPi = (name, rel) =>
	join(
		root,
		"node_modules",
		"@earendil-works",
		"pi-coding-agent",
		"node_modules",
		"@earendil-works",
		name,
		rel,
	);

const aliases = {
	"@earendil-works/pi-coding-agent": join(
		root,
		"node_modules",
		"@earendil-works",
		"pi-coding-agent",
		"dist",
		"index.js",
	),
	"@earendil-works/pi-agent-core": nestedPi("pi-agent-core", "dist/index.js"),
	"@earendil-works/pi-tui": nestedPi("pi-tui", "dist/index.js"),
	"@earendil-works/pi-ai/compat": nestedPi("pi-ai", "dist/compat.js"),
	"@earendil-works/pi-ai/oauth": nestedPi("pi-ai", "dist/oauth.js"),
	"@earendil-works/pi-ai/providers/all": nestedPi(
		"pi-ai",
		"dist/providers/all.js",
	),
	"@earendil-works/pi-ai": nestedPi("pi-ai", "dist/compat.js"),
	typebox: resolveFromPi("typebox"),
	"typebox/compile": resolveFromPi("typebox/compile"),
	"typebox/value": resolveFromPi("typebox/value"),
};

const jiti = createJiti(import.meta.url, {
	moduleCache: false,
	alias: aliases,
});

// Minimal mock pi — enough to run the factory bodies.
function createMockPi() {
	const registered = { commands: [], events: [], tools: [] };
	const api = {
		on(event, _handler) {
			registered.events.push(event);
		},
		registerCommand(name, _opts) {
			registered.commands.push(name);
		},
		registerTool(tool) {
			registered.tools.push(tool?.name);
		},
		getActiveTools: () => ["bash", "read", "grep", "edit", "write"],
		setActiveTools: (_tools) => {},
		appendEntry: (_type, _data) => {},
	};
	return { api, registered };
}

async function loadExtension(relPath, label, expected) {
	const extUrl = new URL(relPath, import.meta.url);
	const factory = await jiti.import(extUrl.pathname, { default: true });
	if (typeof factory !== "function") {
		console.error(
			`FAIL (${label}): extension does not export a factory function`,
		);
		process.exit(1);
	}
	const { api, registered } = createMockPi();
	await factory(api);
	console.log(`${label}: jiti load: OK`);
	console.log(
		`${label}: commands: ${[...registered.commands].sort().join(", ")}`,
	);
	console.log(
		`${label}: tools: ${[...registered.tools].sort().join(", ") || "(none)"}`,
	);
	for (const c of expected.commands ?? []) {
		if (!registered.commands.includes(c)) {
			console.error(`FAIL (${label}): missing command /${c}`);
			process.exit(1);
		}
	}
	for (const t of expected.tools ?? []) {
		if (!registered.tools.includes(t)) {
			console.error(`FAIL (${label}): missing tool ${t}`);
			process.exit(1);
		}
	}
	for (const e of expected.events ?? []) {
		if (!registered.events.includes(e)) {
			console.error(`FAIL (${label}): missing event handler ${e}`);
			process.exit(1);
		}
	}
}

await loadExtension("../codepi-modes.ts", "codepi-modes", {
	commands: ["codepi-ask", "codepi-implement", "codepi-plan"],
	events: ["session_start", "tool_call", "before_agent_start"],
});

await loadExtension("../codepi-bash.ts", "codepi-bash", {
	commands: ["codepi-bash-ask", "codepi-bash-allow", "codepi-bash-disable"],
	events: ["session_start"],
	tools: [],
});

await loadExtension("../codepi-context.ts", "codepi-context", {
	events: ["session_start", "before_agent_start"],
	tools: ["get_editor_context", "get_git_diff"],
});

await loadExtension("../codepi-task.ts", "codepi-task", {
	commands: [
		"codepi-task-create",
		"codepi-task-edit",
		"codepi-task-delete",
		"codepi-task-run",
		"codepi-task-list",
	],
	events: ["before_agent_start", "agent_start", "tool_result", "agent_end"],
	tools: [
		"codepi-task-create",
		"codepi-task-edit",
		"codepi-task-delete",
		"codepi-task-run",
		"codepi-task-list",
	],
});

console.log("smoke test: PASS");
process.exit(0);
