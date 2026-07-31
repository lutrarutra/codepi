import React, { useState, useEffect, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import type { ChatMessage, ToolCallState, InteractionStats } from "../types";
import { EditCard } from "./EditCard";

function copyToClipboard(text: string) {
	navigator.clipboard.writeText(text).catch(() => {});
}

function extractText(node: React.ReactNode): string {
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(extractText).join("");
	if (node && typeof node === "object" && "props" in node)
		return extractText((node as any).props.children);
	return "";
}

/** Clean up thinking text: add space after period when followed by a letter */
function cleanLine(line: string): string {
	return line.replace(/\.([a-zA-Z])/g, ". $1");
}

interface Props {
	message: ChatMessage;
	onAcceptFile?: (proposalId: string) => void;
	onRejectFile?: (proposalId: string) => void;
	onOpenDiff?: (proposalId: string) => void;
}

export function MessageBubble({ message, onAcceptFile, onRejectFile, onOpenDiff }: Props) {
	const [thinkingOpen, setThinkingOpen] = useState<Record<number, boolean>>({});

	// All thinking blocks start collapsed
	useEffect(() => {
		setThinkingOpen({});
	}, [message.blocks.length]);

	const hasContent = message.blocks.length > 0 || message.toolCalls.length > 0;
	const thinkCount = message.blocks.filter((b) => b.type === "thinking").length;
	let thinkIdx = 0;

	return (
		<>
			{message.blocks.map((block, i) => {
				if (block.type === "thinking") {
					const myIdx = thinkIdx++;
					const isLast = i === message.blocks.length - 1;
					return (
						<div key={i} className="thinking-wrapper">
							<button
								className={`thinking-header ${!message.complete && isLast && !thinkingOpen[i] ? "shimmer" : ""}`}
								onClick={() =>
									setThinkingOpen((prev) => ({ ...prev, [i]: !prev[i] }))
								}
							>
								<span className="thinking-header-icon">
									{message.complete ? (
										<svg
											width="10"
											height="10"
											viewBox="0 0 24 24"
											fill="none"
											stroke="var(--text-muted)"
											stroke-width="2.5"
											stroke-linecap="round"
											stroke-linejoin="round"
										>
											<polyline points="20 6 9 17 4 12" />
										</svg>
									) : (
										<svg
											width="10"
											height="10"
											viewBox="0 0 24 24"
											fill="none"
											stroke="var(--accent)"
											stroke-width="2.5"
										>
											<circle cx="12" cy="12" r="10" />
										</svg>
									)}
								</span>
								<span className="thinking-header-label">
									{!message.complete && isLast
										? "Thinking…"
										: `Thought ${segLabel(myIdx, thinkCount)}`}
								</span>
								<span
									className={`thinking-header-chevron ${thinkingOpen[i] ? "open" : ""}`}
								>
									<svg
										width="10"
										height="10"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										stroke-width="2"
										stroke-linecap="round"
										stroke-linejoin="round"
									>
										<polyline points="9 18 15 12 9 6" />
									</svg>
								</span>
							</button>
							{thinkingOpen[i] && (
								<div className="thinking-content">
									{block.content.split("\n").map((line, j) => (
										<div key={j} className="thinking-text">
											{cleanLine(line) || "\u00A0"}
										</div>
									))}
								</div>
							)}
						</div>
					);
				}
				if (block.type === "qa_block") {
					return <InlineQABlock key={i} block={block} />;
				}
				return (
					<div key={i} className="markdown-content">
						<ReactMarkdown
							remarkPlugins={[remarkGfm]}
							rehypePlugins={[rehypeHighlight]}
							components={{
								code({ className, children, ...props }) {
									const match = /language-(\w+)/.exec(className || "");
									if (match)
										return (
											<CodeBlock language={match[1]} className={className}>
												{children}
											</CodeBlock>
										);
									return <InlineCode {...props}>{children}</InlineCode>;
								},
								pre({ children }) {
									return <>{children}</>;
								},
							}}
						>
							{block.content}
						</ReactMarkdown>
						{!message.complete && i === message.blocks.length - 1 && (
							<span className="typing-cursor" />
						)}
					</div>
				);
			})}

			{message.toolCalls.length > 0 && message.complete && (
				<InteractionSummary
					stats={message.interaction}
					toolCalls={message.toolCalls}
				/>
			)}

			{message.toolCalls.some((tc) => tc.editProposal) && (
				<div className="edit-cards">
					{message.toolCalls
						.filter((tc) => tc.editProposal)
						.map((tc) => (
							<EditCard
								key={tc.toolCallId}
								toolCall={tc}
								onAcceptFile={onAcceptFile ?? (() => {})}
								onRejectFile={onRejectFile ?? (() => {})}
								onOpenDiff={onOpenDiff ?? (() => {})}
							/>
						))}
				</div>
			)}

			{!message.complete && !hasContent && (
				<div className="typing-indicator">
					<span className="typing-dot" />
					<span className="typing-dot" />
					<span className="typing-dot" />
				</div>
			)}

			{message.complete && !hasContent && (
				<div style={{ color: "var(--text-muted)", fontSize: "12px" }}>
					(no response)
				</div>
			)}
		</>
	);
}

// ── Memoized Code Block ───────────────────────────────────────

const CodeBlock = React.memo(function CodeBlock({
	language,
	className,
	children,
}: {
	language: string;
	className?: string;
	children: React.ReactNode;
}) {
	const [copied, setCopied] = useState(false);
	const codeStr = extractText(children).replace(/\n$/, "");

	const handleCopy = useCallback(() => {
		copyToClipboard(codeStr);
		setCopied(true);
		setTimeout(() => setCopied(false), 1500);
	}, [codeStr]);

	return (
		<div className="code-block-wrapper">
			<div className="code-block-header">
				<span className="code-lang">{language}</span>
				<button
					className="code-copy-btn"
					onClick={handleCopy}
					title="Copy code"
				>
					{copied ? (
						<svg
							width="14"
							height="14"
							viewBox="0 0 24 24"
							fill="none"
							stroke="#4ec9b0"
							strokeWidth="2.5"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<polyline points="20 6 9 17 4 12" />
						</svg>
					) : (
						<svg
							width="14"
							height="14"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
							<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
						</svg>
					)}
				</button>
			</div>
			<pre className="code-block">
				<code className={className}>{children}</code>
			</pre>
		</div>
	);
});

// ── Inline Code with copy ─────────────────────────────────────

const InlineCode = React.memo(function InlineCode({
	children,
	...props
}: {
	children: React.ReactNode;
	[key: string]: any;
}) {
	const [copied, setCopied] = useState(false);
	const codeStr = extractText(children);

	const handleClick = useCallback(() => {
		copyToClipboard(codeStr);
		setCopied(true);
		setTimeout(() => setCopied(false), 1500);
	}, [codeStr]);

	return (
		<code
			className={`inline-code ${copied ? "copied" : ""}`}
			onClick={handleClick}
			title="Click to copy"
			{...props}
		>
			{children}
			{copied && <span className="inline-copy-ok">✓</span>}
		</code>
	);
});

// ── Helpers ──────────────────────────────────────────────────

function fmt(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return String(n);
}

function segLabel(i: number, total: number): string {
	if (total <= 3) return ["first", "second", "third"][i] || `${i + 1}th`;
	return `${i + 1} of ${total}`;
}

// ── Inline Q&A Block (rendered directly from message content) ─

function InlineQABlock({
	block,
}: {
	block: { questions: any[]; answers: Record<string, any> };
}) {
	const [open, setOpen] = useState(false);
	const { questions, answers } = block;

	if (!questions || questions.length === 0) return null;

	return (
		<div className="question-summary">
			<button
				className="question-summary-header"
				onClick={() => setOpen(!open)}
			>
				<span className="question-summary-label">Questions & Answers</span>
				<span className="question-summary-count">
					{questions.length} question{questions.length > 1 ? "s" : ""}
				</span>
				<span className={`question-summary-chevron ${open ? "open" : ""}`}>
					<svg
						width="10"
						height="10"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
					>
						<polyline points="9 18 15 12 9 6" />
					</svg>
				</span>
			</button>
			{open && (
				<div className="question-summary-body">
					{questions.map((q: any, i: number) => {
						const a = answers[q.header];
						return (
							<div key={i} className="qa-item">
								<div className="qa-question">
									<span className="qa-index">Q{i + 1}</span>
									<span className="qa-header-tag">{q.header}</span>
									<span className="qa-text">{q.question}</span>
								</div>
								{a && !a.skipped ? (
									<div className="qa-answer">
										<span className="qa-label">Answer:</span>
										{q.options && q.options.length > 0 && (
											<div className="qa-options-list">
												{q.options.map((opt: any, k: number) => {
													const chosen = a.selected?.includes(opt.label);
													return (
														<div
															key={k}
															className={`qa-option-row ${chosen ? "chosen" : ""}`}
														>
															<span className="qa-option-marker">
																{q.multiSelect
																	? chosen
																		? "☑"
																		: "□"
																	: chosen
																		? "●"
																		: "○"}
															</span>
															<span className="qa-option-label">
																{opt.label}
															</span>
														</div>
													);
												})}
											</div>
										)}
										{a.freeText && (
											<div className="qa-freetext">{a.freeText}</div>
										)}
									</div>
								) : (
									<div className="qa-answer">
										<span className="qa-skipped">Skipped</span>
									</div>
								)}
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}

// ── Question Tool Call Detail ────────────────────────────────

function QuestionToolCallDetail({ toolCall }: { toolCall: ToolCallState }) {
	const questions = (toolCall.args as any)?.questions ?? [];
	let answers: Record<
		string,
		{ selected: string[]; freeText: string | null; skipped: boolean }
	> = {};
	try {
		const parsed = JSON.parse(toolCall.output);
		answers = parsed.answers ?? {};
	} catch {
		/* not ready yet */
	}

	return (
		<div className="tool-call-qa">
			{questions.map((q: any, i: number) => {
				const a = answers[q.header];
				return (
					<div key={i} className="qa-item">
						<div className="qa-question">
							<span className="qa-index">Q{i + 1}</span>
							<span className="qa-header-tag">{q.header}</span>
							<span className="qa-text">{q.question}</span>
						</div>
						{a && !a.skipped ? (
							<div className="qa-answer">
								<span className="qa-label">Answer:</span>
								{a.selected && a.selected.length > 0 && (
									<div className="qa-selected">
										{a.selected.map((s: string, j: number) => (
											<span key={j} className="qa-selected-item">
												{s}
											</span>
										))}
									</div>
								)}
								{a.freeText && <div className="qa-freetext">{a.freeText}</div>}
							</div>
						) : (
							<div className="qa-answer">
								<span className="qa-skipped">Skipped</span>
							</div>
						)}
					</div>
				);
			})}
		</div>
	);
}

// ── Question Summary (collapsible, shown inline in message) ──

// ── Interaction Summary ──────────────────────────────────────

function InteractionSummary({
	stats,
	toolCalls: tcs,
}: {
	stats?: InteractionStats;
	toolCalls: ToolCallState[];
}) {
	const [open, setOpen] = useState(false);
	const [expandedTool, setExpandedTool] = useState<string | null>(null);

	const counts = new Map<string, number>();
	for (const tc of tcs)
		counts.set(tc.toolName, (counts.get(tc.toolName) ?? 0) + 1);

	const shortModel = stats?.modelId?.split("/").pop() || "";
	const dur =
		stats?.duration != null
			? stats.duration < 60
				? `${Math.round(stats.duration)}s`
				: `${Math.floor(stats.duration / 60)}m ${Math.round(stats.duration % 60)}s`
			: "";
	const hasStats = stats != null && (stats.tokensIn > 0 || stats.totalCost > 0);

	return (
		<div className={`interaction-stats ${hasStats ? "" : "no-stats"}`}>
			<button
				className="interaction-stats-summary"
				onClick={() => setOpen(!open)}
			>
				<span className="interaction-stats-dot" />
				{hasStats ? (
					<span className="interaction-stats-label">
						↑{fmt(stats.tokensIn)} · ↓{fmt(stats.tokensOut)} · {dur}
						{stats.totalCost > 0 ? ` · $${stats.totalCost.toFixed(4)}` : ""}
					</span>
				) : (
					<span className="interaction-stats-label">
						{tcs.length} tool call{tcs.length !== 1 ? "s" : ""}
					</span>
				)}
				<span className={`interaction-stats-chevron ${open ? "open" : ""}`}>
					<svg
						width="10"
						height="10"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
					>
						<polyline points="9 18 15 12 9 6" />
					</svg>
				</span>
			</button>
			{open && (
				<div className="interaction-stats-detail">
					{hasStats && (
						<>
							<div className="interaction-stats-row">
								<span className="interaction-stats-key">Model</span>
								<span className="interaction-stats-val">{shortModel}</span>
							</div>
							<div className="interaction-stats-row">
								<span className="interaction-stats-key">Duration</span>
								<span className="interaction-stats-val">{dur}</span>
							</div>
							<div className="interaction-stats-row">
								<span className="interaction-stats-key">Tokens in</span>
								<span className="interaction-stats-val">
									{fmt(stats.tokensIn)}
								</span>
							</div>
							<div className="interaction-stats-row">
								<span className="interaction-stats-key">Tokens out</span>
								<span className="interaction-stats-val">
									{fmt(stats.tokensOut)}
								</span>
							</div>
							{stats.thinkingTokens > 0 && (
								<div className="interaction-stats-row">
									<span className="interaction-stats-key">Thinking</span>
									<span className="interaction-stats-val">
										{fmt(stats.thinkingTokens)}
									</span>
								</div>
							)}
							{stats.cacheHit > 0 && (
								<div className="interaction-stats-row">
									<span className="interaction-stats-key">Cache hit</span>
									<span className="interaction-stats-val">
										{Math.round(stats.cacheHit * 100)}%
									</span>
								</div>
							)}
							{stats.totalCost > 0 && (
								<div className="interaction-stats-row">
									<span className="interaction-stats-key">Cost</span>
									<span className="interaction-stats-val">
										${stats.totalCost.toFixed(6)}
									</span>
								</div>
							)}
						</>
					)}
					{tcs.length > 0 && (
						<div className="interaction-stats-tools">
							<div className="interaction-stats-row">
								<span className="interaction-stats-key">Tools</span>
								<span className="interaction-stats-val">
									{[...counts.entries()].map(([name, count]) => {
										const hasRunning = tcs.some(
											(tc) => tc.toolName === name && tc.running,
										);
										const hasError = tcs.some(
											(tc) => tc.toolName === name && tc.isError,
										);
										return (
											<button
												key={name}
												className={`tool-badge ${expandedTool === name ? "active" : ""} ${hasError ? "error" : ""} ${hasRunning ? "running" : ""}`}
												onClick={() =>
													setExpandedTool(expandedTool === name ? null : name)
												}
											>
												{name}({count})
											</button>
										);
									})}
								</span>
							</div>
							{expandedTool && (
								<div className="tool-call-list">
									{tcs
										.filter((tc) => tc.toolName === expandedTool)
										.map((tc) =>
											tc.toolName === "ask_user_question" ? (
												<QuestionToolCallDetail
													key={tc.toolCallId}
													toolCall={tc}
												/>
											) : (
												<div key={tc.toolCallId} className="tool-call-compact">
													<span
														className={`tool-call-dot ${tc.running ? "running" : tc.isError ? "error" : "ok"}`}
													/>
													<span
														className="tool-call-params-preview"
														title={JSON.stringify(tc.args)}
													>
														{tc.args
															? Object.entries(tc.args)
																	.map(
																		([k, v]) =>
																			`${k}=${String(v).substring(0, 40)}`,
																	)
																	.join(", ")
															: "—"}
													</span>
												</div>
											),
										)}
								</div>
							)}
						</div>
					)}
				</div>
			)}
		</div>
	);
}
