/**
 * Project trust for CodePi sessions.
 *
 * pi's CLI asks "Trust project folder?" before it loads a folder's .pi
 * settings and resources — project packages are installed from npm and
 * project extensions run as code. The CLI resolves that in its own startup
 * (main.js) before building the session services; the SDK path CodePi uses
 * skipped it, so a cloned repository's .pi packages loaded without asking.
 *
 * This mirrors pi's decision order and choices: a saved decision in
 * ~/.pi/agent/trust.json (nearest folder wins), else the defaultProjectTrust
 * setting ("ask" by default), else ask — here in a VS Code modal with pi's
 * five options — and save the answer the same way pi does. Session-only
 * answers are kept in memory for this VS Code window.
 *
 * Not mirrored: user extensions that decide trust through pi's
 * `project_trust` event (the CLI asks them before the prompt).
 */
import * as path from "node:path";

export type DefaultProjectTrust = "ask" | "always" | "never";

export interface TrustOption {
	label: string;
	trusted: boolean;
	/** Decisions to save in trust.json (null removes a saved decision). */
	updates: Array<{ path: string; decision: boolean | null }>;
}

export interface TrustStoreLike {
	get(cwd: string): boolean | null;
	setMany(updates: Array<{ path: string; decision: boolean | null }>): void;
}

export interface ProjectTrustDeps {
	/** pi's hasTrustRequiringProjectResources. */
	hasTrustRequiringProjectResources(cwd: string): boolean;
	store: TrustStoreLike;
	defaultProjectTrust: DefaultProjectTrust;
	/** Ask the user; undefined when they dismissed the prompt. */
	ask?: (cwd: string, options: TrustOption[]) => Promise<TrustOption | undefined>;
}

/** Answers that apply to this window only ("this session only"). */
const sessionDecisions = new Map<string, boolean>();

export function __resetProjectTrustForTests(): void {
	sessionDecisions.clear();
}

/** pi's choices, in pi's order (trust-manager getProjectTrustOptions). */
export function projectTrustOptions(cwd: string): TrustOption[] {
	const dir = path.resolve(cwd);
	const parent = path.dirname(dir);
	const options: TrustOption[] = [
		{ label: "Trust", trusted: true, updates: [{ path: dir, decision: true }] },
	];
	if (parent !== dir) {
		options.push({
			label: `Trust parent folder (${parent})`,
			trusted: true,
			updates: [
				{ path: parent, decision: true },
				{ path: dir, decision: null },
			],
		});
	}
	options.push(
		{ label: "Trust (this session only)", trusted: true, updates: [] },
		{ label: "Do not trust", trusted: false, updates: [{ path: dir, decision: false }] },
		{ label: "Do not trust (this session only)", trusted: false, updates: [] },
	);
	return options;
}

export const PROJECT_TRUST_PROMPT =
	"This allows pi to load .pi settings and resources, install missing project packages, and execute project extensions.";

/**
 * Whether pi may load the folder's project resources. Without `ask` (the
 * Extensions view probe, the settings dashboard) an undecided folder counts
 * as untrusted and nobody is prompted.
 */
export async function resolveProjectTrust(
	cwd: string,
	deps: ProjectTrustDeps,
): Promise<boolean> {
	const dir = path.resolve(cwd);
	if (!deps.hasTrustRequiringProjectResources(dir)) {
		return deps.store.get(dir) ?? true;
	}
	const session = sessionDecisions.get(dir);
	if (session !== undefined) return session;
	const saved = deps.store.get(dir);
	if (saved !== null) return saved;
	if (deps.defaultProjectTrust === "always") return true;
	if (deps.defaultProjectTrust === "never") return false;
	if (!deps.ask) return false;
	const choice = await deps.ask(dir, projectTrustOptions(dir));
	if (!choice) return false; // dismissed: untrusted, ask again next time
	if (choice.updates.length > 0) deps.store.setMany(choice.updates);
	else sessionDecisions.set(dir, choice.trusted);
	return choice.trusted;
}
