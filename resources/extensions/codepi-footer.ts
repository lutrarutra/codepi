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
							input += m.usage.input;
							output += m.usage.output;
							cost += m.usage.cost.total;
							reasoning += m.usage.reasoningTokens ?? 0;
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
							? theme.fg("accent", "R") + theme.fg("text", fmt(reasoning))
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

					// Mode badge (codepi-modes extension) — icon + lowercase label, next
					// to the thinking level. ASK → accent (blue), PLAN → warning
					// (amber), IMPLEMENT → success (green). Icons are nerd-font
					// glyphs shipped in the bundled Fira Code Nerd Font.
					const modeStatus = footerData
						.getExtensionStatuses()
						.get("codepi-modes");
					const modeStyles: Record<
						string,
						{ icon: string; label: string; color: string }
					> = {
						ASK: { icon: "\u{F059}", label: "ask", color: "accent" },
						PLAN: { icon: "\u{F0CA}", label: "plan", color: "warning" },
						IMPLEMENT: {
							icon: "\u{F121}",
							label: "implement",
							color: "success",
						},
					};
					const modeStyle = modeStatus ? modeStyles[modeStatus] : undefined;
					const modeBadge = modeStyle
						? theme.fg(
								modeStyle.color as any,
								modeStyle.icon + " " + modeStyle.label,
							)
						: "";

					// Bash approval badge (codepi-bash extension) — shown only when
					// the extension is loaded. Terminal icon + BOTH mode options
					// (`ask/allow`) so it reads as a toggle, never confused with the
					// codepi-modes badge. The ACTIVE option is highlighted (bold +
					// color: ask → warning/amber, allow → success/green) and the
					// inactive one is dimmed — no brackets needed.
					// Rendered right of the thinking level, immediately left of the
					// git branch.
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

					// Pad left side so right side is right-aligned
					const leftContent = left + midSep;
					const padNeeded = Math.max(
						1,
						width - visibleWidth(leftContent) - visibleWidth(right),
					);
					const pad = " ".repeat(padNeeded);

					return [truncateToWidth(leftContent + pad + right, width)];
				},
			};
		});
	});
}
