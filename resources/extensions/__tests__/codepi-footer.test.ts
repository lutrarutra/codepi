import { describe, expect, it, vi } from "vitest";
import customFooterFactory from "../codepi-footer";

// ── Mocks ────────────────────────────────────────────────────

function createMockPi() {
	const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
	return {
		api: {
			on(event: string, handler: (event: any, ctx: any) => unknown) {
				const list = handlers.get(event) ?? [];
				list.push(handler);
				handlers.set(event, list);
			},
			registerCommand() {},
			getActiveTools: () => [],
			setActiveTools() {},
			appendEntry() {},
		},
		handlers,
	};
}

const mockTheme = {
	fg: (color: string, text: string) => `{${color}:${text}}`,
	bold: (text: string) => `*${text}*`,
	dim: (text: string) => `~${text}~`,
};

function createFooterData(
	modeStatus: string | undefined,
	branch: string | null = null,
	bashStatus: string | undefined = undefined,
) {
	const statuses = new Map<string, string>();
	if (modeStatus) statuses.set("codepi-modes", modeStatus);
	if (bashStatus) statuses.set("codepi-bash", bashStatus);
	return {
		getExtensionStatuses: () => statuses,
		getGitBranch: () => branch,
		onBranchChange: () => () => {},
	};
}

/** Load the footer factory and capture the component created on session_start. */
async function loadFooter(
	modeStatus: string | undefined,
	bashStatus: string | undefined = undefined,
	branch: string | null = null,
) {
	const mock = createMockPi();
	customFooterFactory(mock.api as any);

	let footerFactory:
		| ((tui: any, theme: any, footerData: any) => any)
		| undefined;
	const ctx = {
		sessionManager: { getBranch: () => [] },
		getContextUsage: () => undefined,
		model: undefined,
		ui: { setFooter: (f: any) => (footerFactory = f) },
	};
	const handler = mock.handlers.get("session_start")?.[0];
	expect(handler).toBeDefined();
	await handler!({ type: "session_start", reason: "startup" }, ctx);
	expect(footerFactory).toBeDefined();

	const tui = { requestRender: vi.fn() };
	const component = footerFactory!(
		tui,
		mockTheme,
		createFooterData(modeStatus, branch, bashStatus),
	);
	return { component, tui };
}

// ── Tests ────────────────────────────────────────────────────

// Nerd-font codicons used by the mode badge (must match codepi-footer.ts).
// Codepoints are specific to the bundled Fira Code Nerd Font — verified
// against its cmap (cod-question U+EB32, cod-checklist U+EAB3, cod-code
// U+EAC4); the standard Nerd Fonts cheat-sheet codepoints differ for these.
const ICON_ASK = "\u{EB32}"; // cod-question
const ICON_PLAN = "\u{EAB3}"; // cod-checklist
const ICON_IMPLEMENT = "\u{EAC4}"; // cod-code
const ICON_BASH = "\u{EBCA}"; // cod-terminal_bash (bash approval badge)

describe("codepi-footer: mode badge", () => {
	it("renders the ASK badge in accent (blue) with icon and lowercase label", async () => {
		const { component } = await loadFooter("ASK");
		const [line] = component.render(200);
		expect(line).toContain(`{accent:${ICON_ASK} *ask*}`);
	});

	it("renders the PLAN badge in warning (amber) with icon and lowercase label", async () => {
		const { component } = await loadFooter("PLAN");
		const [line] = component.render(200);
		expect(line).toContain(`{warning:${ICON_PLAN} *plan*}`);
	});

	it("renders the IMPLEMENT badge in success (green) with icon and lowercase label", async () => {
		const { component } = await loadFooter("IMPLEMENT");
		const [line] = component.render(200);
		expect(line).toContain(`{success:${ICON_IMPLEMENT} *implement*}`);
	});

	it("places the mode badge leftmost, before the model name", async () => {
		const mock = createMockPi();
		customFooterFactory(mock.api as any);
		let footerFactory:
			| ((tui: any, theme: any, footerData: any) => any)
			| undefined;
		const ctx = {
			sessionManager: { getBranch: () => [] },
			getContextUsage: () => undefined,
			model: { id: "claude-sonnet-4" },
			ui: { setFooter: (f: any) => (footerFactory = f) },
		};
		const handler = mock.handlers.get("session_start")?.[0];
		expect(handler).toBeDefined();
		await handler!({ type: "session_start", reason: "startup" }, ctx);
		expect(footerFactory).toBeDefined();

		const component = footerFactory!(
			{ requestRender: () => {} },
			mockTheme,
			createFooterData("PLAN", "main"),
		);
		// Wide render: the mock theme's {color:text} tokens inflate visible
		// width, and the footer is inset by the side margin — a narrow render
		// would truncate the rightmost (branch) segment.
		const [line] = component.render(400);
		const modeIdx = line.indexOf(`{warning:${ICON_PLAN} *plan*}`);
		const modelIdx = line.indexOf("{accent:claude-sonnet-4}");
		const levelIdx = line.indexOf("{muted:high}");
		const branchIdx = line.indexOf("{toolDiffAdded: main}");
		expect(modeIdx).toBeGreaterThanOrEqual(0);
		expect(modelIdx).toBeGreaterThan(modeIdx);
		expect(levelIdx).toBeGreaterThan(modelIdx);
		expect(branchIdx).toBeGreaterThan(levelIdx);
	});

	it("renders no badge when the codepi-modes extension is absent", async () => {
		const { component } = await loadFooter(undefined);
		const [line] = component.render(200);
		expect(line).not.toContain("ask");
		expect(line).not.toContain("plan");
		expect(line).not.toContain("implement");
		expect(line).not.toContain("codepi-modes");
	});

	it("renders the bash badge as a toggle with the ask option highlighted in warning", async () => {
		const { component } = await loadFooter(undefined, "ask", "main");
		const [line] = component.render(400);
		// Active `ask` is bold + warning; inactive `allow` is dimmed.
		expect(line).toContain(
			`{warning:${ICON_BASH} }{warning:*ask*}{dim:/allow}`,
		);
		const bashIdx = line.indexOf(
			`{warning:${ICON_BASH} }{warning:*ask*}{dim:/allow}`,
		);
		const branchIdx = line.indexOf("{toolDiffAdded: main}");
		expect(bashIdx).toBeGreaterThanOrEqual(0);
		expect(branchIdx).toBeGreaterThan(bashIdx);
	});

	it("renders the bash badge with the allow option highlighted in success", async () => {
		const { component } = await loadFooter(undefined, "auto");
		const [line] = component.render(200);
		expect(line).toContain(
			`{success:${ICON_BASH} }{dim:ask/}{success:*allow*}`,
		);
	});

	it("renders the bash badge with disabled highlighted in error", async () => {
		const { component } = await loadFooter(undefined, "disabled");
		const [line] = component.render(200);
		expect(line).toContain(
			`{error:${ICON_BASH} }{error:*disabled*}`,
		);
	});

	it("renders no bash badge when the codepi-bash extension is absent", async () => {
		const { component } = await loadFooter(undefined, undefined);
		const [line] = component.render(200);
		expect(line).not.toContain(ICON_BASH);
	});

	it("truncates the footer to the terminal width", async () => {
		const { component } = await loadFooter("IMPLEMENT");
		const [line] = component.render(40);
		expect(line.length).toBeLessThanOrEqual(40 * 2); // ANSI codes inflate length
	});

	it("insets the footer by one cell on each side", async () => {
		const { component } = await loadFooter("ASK");
		const [line] = component.render(400);
		// One leading and one trailing cell of margin — content never touches
		// the terminal edges. The leftmost content is the ↑ input stat (the
		// mode badge is right-aligned); a wide render keeps the mock-theme
		// brace inflation from truncating it away.
		expect(line.startsWith(" ")).toBe(true);
		expect(line.endsWith(" ")).toBe(true);
		expect(line.slice(1).startsWith("{success:↑}{text:0}")).toBe(true);
		expect(line).toContain(`{accent:${ICON_ASK} *ask*}`);
	});
});
