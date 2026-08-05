import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		// Track thinking level from events
		let thinkingLevel = "high";

		pi.on("thinking_level_select", async (event) => {
			thinkingLevel = event.level;
		});

		// Track tokens/sec for the most recent assistant response
		let lastSpeed: number | null = null;
		let assistantStartTime: number | null = null;

		pi.on("message_start", async (event) => {
			if (event.message.role === "assistant") {
				assistantStartTime = Date.now();
			}
		});

		pi.on("message_end", async (event) => {
			if (event.message.role === "assistant") {
				const m = event.message as AssistantMessage;
				const outputTokens = m.usage.output;
				const elapsed = assistantStartTime
					? (Date.now() - assistantStartTime) / 1000
					: 0;

				// Skip if elapsed is unreasonably small (e.g. restored from session)
				if (elapsed > 0.5 && outputTokens > 0) {
					lastSpeed = Math.round(outputTokens / elapsed);
				}
				assistantStartTime = null;
			}
		});

		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsub = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose: unsub,
				invalidate() {},
				render(width: number): string[] {
					let input = 0,
						output = 0,
						cost = 0,
						reasoning = 0;
					for (const e of ctx.sessionManager.getBranch()) {
						if (e.type === "message" && e.message.role === "assistant") {
							const m = e.message as AssistantMessage;
							input += m.usage.input ?? 0;
							output += m.usage.output ?? 0;
							cost += m.usage.cost?.total ?? 0;
							reasoning += m.usage.reasoning ?? 0;
						}
					}

					const fmt = (n: number) => {
						if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
						if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
						return `${n}`;
					};

					// Separator
					const sep = " " + theme.fg("dim", "│") + " ";

					// Session context usage — model's context window
					const contextUsage = ctx.getContextUsage();
					const ctxLimit =
						(contextUsage as { limit?: number } | undefined)?.limit ??
						ctx.model?.contextWindow ??
						0;
					const ctxTokens = contextUsage?.tokens ?? 0;
					let contextPct = "";
					if (ctxLimit > 0) {
						const pct = (ctxTokens / ctxLimit) * 100;
						const color = pct > 80 ? "error" : pct > 50 ? "warning" : "success";
						contextPct =
							theme.fg(color, `${pct.toFixed(1)}%`) +
							theme.fg("dim", "/" + fmt(ctxLimit));
					}

					const branch = footerData.getGitBranch();

					// Colored stat labels — using valid theme token names only
					const arrowUp =
						theme.fg("success", "↑") + theme.fg("text", fmt(input));
					const arrowDown =
						theme.fg("error", "↓") + theme.fg("text", fmt(output));
					const reasoningStr =
						reasoning > 0
							? theme.fg("accent", "\u{EE9C}") +
								theme.fg("text", " " + fmt(reasoning))
							: "";
					const costStr = theme.fg("warning", "$" + cost.toFixed(3));
					const speedStr =
						lastSpeed !== null
							? theme.fg("mdLink", fmt(lastSpeed) + " t/s")
							: "";

					// Thinking level dot colors — using valid tokens
					const levelColors: Record<string, string> = {
						off: "thinkingOff",
						minimal: "thinkingMinimal",
						low: "thinkingLow",
						medium: "thinkingMedium",
						high: "thinkingHigh",
						"extra-high": "thinkingXhigh",
					};
					const levelColor = levelColors[thinkingLevel] || "accent";
					const levelDot = theme.fg(levelColor as any, "●");
					const modelStr = theme.fg("accent", ctx.model?.id || "no-model");
					const levelStr = theme.fg("muted", thinkingLevel);

					// Git branch — use success color
					const gitStr = branch ? theme.fg("toolDiffAdded", " " + branch) : "";

					// Mode badge (codepi-modes extension) — icon + lowercase bold label,
					// next to the thinking level. ASK → accent (blue), PLAN → warning
					// (amber), IMPLEMENT → success (green). Icons are nerd-font
					// codicons shipped in the bundled Fira Code Nerd Font (same family
					// as the bash badge below); the label is bold like the bash
					// badge's ask/allow so both read at the same visual weight.
					const modeStatus = footerData
						.getExtensionStatuses()
						.get("codepi-modes");
					const modeStyles: Record<
						string,
						{ icon: string; label: string; color: string }
					> = {
						ASK: { icon: "\u{EB32}", label: "ask", color: "accent" },
						PLAN: { icon: "\u{EAB3}", label: "plan", color: "warning" },
						IMPLEMENT: {
							icon: "\u{EAC4}",
							label: "implement",
							color: "success",
						},
					};
					const modeStyle = modeStatus ? modeStyles[modeStatus] : undefined;
					const modeBadge = modeStyle
						? theme.fg(
								modeStyle.color as any,
								modeStyle.icon + " " + theme.bold(modeStyle.label),
							)
						: "";

					// Bash approval badge (codepi-bash extension) — shown only when
					// the extension is loaded. Terminal icon + toggle pair (ask/allow)
					// or disabled. The ACTIVE option is highlighted (bold + color:
					// ask → warning/amber, allow → success/green, disabled →
					// error/red) — no brackets needed. Rendered right of the thinking
					// level, immediately left of the git branch.
					const bashStatus = footerData
						.getExtensionStatuses()
						.get("codepi-bash");
					const BASH_ICON = "\u{EBCA}"; // nf-cod-terminal_bash (terminal + $ prompt)
					const bashBadge =
						bashStatus === "ask"
							? theme.fg("warning", BASH_ICON + " ") +
								theme.fg("warning", theme.bold("ask")) +
								theme.fg("dim", "/allow")
							: bashStatus === "auto"
								? theme.fg("success", BASH_ICON + " ") +
									theme.fg("dim", "ask/") +
									theme.fg("success", theme.bold("allow"))
								: bashStatus === "disabled"
									? theme.fg("error", BASH_ICON + " ") +
										theme.fg("error", theme.bold("disabled"))
									: "";

					// ===== LEFT: stats with │ separators between each =====
					const leftParts = [
						arrowUp,
						arrowDown,
						reasoningStr,
						costStr,
						contextPct,
						speedStr,
					].filter(Boolean);

					const left = leftParts.join(sep);

					// ===== RIGHT: mode, model, thinking level, bash badge, branch =====
					const rightParts = [
						modeBadge,
						modelStr,
						levelDot + " " + levelStr,
						bashBadge,
						gitStr,
					].filter(Boolean);

					const right = rightParts.join(" " + theme.fg("dim", "•") + " ");
					const midSep = right ? " " + theme.fg("dim", "│") + " " : "";

					// Side margin: keep the footer content off the terminal edges (1
					// cell ≈ 5-10px depending on the terminal font).
					const MARGIN = 1;
					const innerWidth = Math.max(1, width - MARGIN * 2);

					// Render one footer row: 1-cell margin on each side. Truncates
					// with "..." only when a single row alone overflows the window
					// (very narrow terminals — last resort).
					const makeRow = (content: string, rightAlign: boolean) => {
						const row =
							visibleWidth(content) <= innerWidth
								? content
								: truncateToWidth(content, innerWidth);
						const lead = rightAlign
							? " ".repeat(Math.max(0, innerWidth - visibleWidth(row)))
							: "";
						return (
							" ".repeat(MARGIN) +
							lead +
							row +
							" ".repeat(
								Math.max(0, width - MARGIN - visibleWidth(lead + row)),
							)
						);
					};

					// Single line when everything fits (current layout, right side
					// right-aligned via padding). Otherwise split into two rows:
					// left above, right below — the right side is never collapsed.
					const leftContent = left + midSep;
					if (
						right &&
						visibleWidth(leftContent) + visibleWidth(right) <= innerWidth
					) {
						const padNeeded = Math.max(
							1,
							innerWidth - visibleWidth(leftContent) - visibleWidth(right),
						);
						return [makeRow(leftContent + " ".repeat(padNeeded) + right, false)];
					}
					if (!right) {
						// Right-less footer (defensive; today's right side always has
						// at least the model + thinking level): single truncated row.
						return [makeRow(left, false)];
					}
					return [makeRow(left, false), makeRow(right, true)];
				},
			};
		});
	});
}
