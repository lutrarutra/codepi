// Smoke test: load the COMPILED bundled extension entry points
// (resources/extensions/dist/*.js — what the packaged extension ships) through
// jiti (the same loader pi uses at runtime) against a mock pi API.
// Prerequisite: `make build-bundled` (the Makefile's smoke target does this).
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync } from "node:fs";

// Load jiti the way pi itself does: import pi's own loader module, which
// re-exports createJiti resolved from pi's package context (jiti is a
// dependency of pi-coding-agent, not of CodePi).
const { createJiti } = await import(
	new URL(
		"./core/extensions/jiti-loader.js",
		pathToFileURL(
			fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")),
		),
	).href,
);

// jiti resolves each alias to a concrete file, mirroring pi's loader map
// (loader.ts getAliases) so the compiled bundled extensions import the same
// modules at runtime as they do under pi's own loader. pi 1.0 hoists its
// dependencies into the root node_modules and resolves each entry through the
// ESM resolver, so do the same here.
const resolveEntry = (specifier) => fileURLToPath(import.meta.resolve(specifier));

const aliases = {
	"@earendil-works/pi-coding-agent": resolveEntry(
		"@earendil-works/pi-coding-agent",
	),
	"@earendil-works/pi-agent-core": resolveEntry(
		"@earendil-works/pi-agent-core",
	),
	"@earendil-works/pi-tui": resolveEntry("@earendil-works/pi-tui"),
	"@earendil-works/pi-ai/compat": resolveEntry("@earendil-works/pi-ai/compat"),
	"@earendil-works/pi-ai/oauth": resolveEntry("@earendil-works/pi-ai/oauth"),
	"@earendil-works/pi-ai/providers/all": resolveEntry(
		"@earendil-works/pi-ai/providers/all",
	),
	"@earendil-works/pi-ai": resolveEntry("@earendil-works/pi-ai/compat"),
	typebox: resolveEntry("typebox"),
	"typebox/compile": resolveEntry("typebox/compile"),
	"typebox/value": resolveEntry("typebox/value"),
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
	if (!existsSync(extUrl)) {
		console.error(
			`FAIL (${label}): ${relPath} not found — run \`make build-bundled\` first`,
		);
		process.exit(1);
	}
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

await loadExtension("../dist/codepi-modes.js", "codepi-modes", {
	commands: ["codepi-ask", "codepi-implement", "codepi-plan"],
	events: ["session_start", "tool_call", "before_agent_start"],
});

await loadExtension("../dist/codepi-bash.js", "codepi-bash", {
	commands: ["codepi-bash-ask", "codepi-bash-allow", "codepi-bash-disable"],
	events: ["session_start"],
	tools: [],
});

await loadExtension("../dist/codepi-context.js", "codepi-context", {
	events: ["session_start", "before_agent_start"],
	tools: ["get_editor_context", "get_git_diff"],
});

await loadExtension("../dist/codepi-task.js", "codepi-task", {
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
