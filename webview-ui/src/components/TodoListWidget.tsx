import React, { useCallback } from "react";

// ── Types ──────────────────────────────────────────────────────

interface TodoItem {
	id: number;
	title: string;
	status: "not-started" | "in-progress" | "completed";
}

interface TodoListWidgetProps {
	todos: TodoItem[];
	expanded: boolean;
	onToggleExpand: () => void;
	onTodoToggle: (id: number) => void;
	onClear: () => void;
	onMoveUp: (id: number) => void;
	onMoveDown: (id: number) => void;
}

// ── Status icon helper ─────────────────────────────────────────

function statusIcon(status: string): string {
	switch (status) {
		case "completed":
			return "check-circle";
		case "in-progress":
			return "record";
		default:
			return "circle-outline";
	}
}

function statusColor(status: string): string {
	switch (status) {
		case "completed":
			return "var(--vscode-charts-green, #2ea043)";
		case "in-progress":
			return "var(--vscode-charts-blue, #58a6ff)";
		default:
			return "var(--text-muted, #8b949e)";
	}
}

// ── Counts ─────────────────────────────────────────────────────

function summarize(todos: TodoItem[]): string {
	const total = todos.length;
	const done = todos.filter((t) => t.status === "completed").length;
	const inProg = todos.find((t) => t.status === "in-progress");
	if (inProg) {
		const idx = todos.indexOf(inProg) + 1;
		return `${inProg.title} (${idx}/${total})`;
	}
	if (done === total && total > 0) {
		return `All done (${done}/${total})`;
	}
	return `${done}/${total}`;
}

// ── SVG icons for buttons ──────────────────────────────────────

function ChevronRight() {
	return (
		<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
			<polyline points="9 18 15 12 9 6" />
		</svg>
	);
}

function ChevronDown() {
	return (
		<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
			<polyline points="6 9 12 15 18 9" />
		</svg>
	);
}

// ── Component ──────────────────────────────────────────────────

export default function TodoListWidget({
	todos,
	expanded,
	onToggleExpand,
	onTodoToggle,
	onClear,
	onMoveUp,
	onMoveDown,
}: TodoListWidgetProps) {
	if (todos.length === 0) return null;

	const total = todos.length;
	const done = todos.filter((t) => t.status === "completed").length;
	const current = todos.find((t) => t.status === "in-progress");
	const summary = summarize(todos);
	const firstIncomplete = todos.find((t) => t.status !== "completed");

	return (
		<div className={`todo-list-widget ${todos.length > 0 ? "has-todos" : ""}`}>
			{/* Expand/Collapse header bar */}
			<button className="todo-list-expand" onClick={onToggleExpand} aria-expanded={expanded}>
				<div className="todo-list-title-section">
					<span className="todo-expand-icon">{expanded ? <ChevronDown /> : <ChevronRight />}</span>
					{expanded ? (
						<span className="todo-list-title">Todos ({done}/{total})</span>
					) : (
						<span className="todo-list-title">
							{current && (
								<>
									<span className="todo-title-icon" style={{ color: statusColor("in-progress") }}>
										<RecordIcon />
									</span>
									{summary}
								</>
							)}
							{!current && done === total && total > 0 && (
								<span>All done ({done}/{total})</span>
							)}
							{!current && done < total && firstIncomplete && (
								<>
									<span className="todo-title-icon" style={{ color: statusColor("not-started") }}>
										<CircleIcon />
									</span>
									{summary}
								</>
							)}
						</span>
					)}
				</div>
				<div className="todo-clear-button-container">
					<button className="todo-clear-button" onClick={(e) => { e.stopPropagation(); onClear(); }} title="Clear all todos">
						<ClearIcon />
					</button>
				</div>
			</button>

			{/* Expanded list */}
			{expanded && (
				<div className="todo-list-container" role="list" aria-label="Todo list">
					{todos.map((todo) => (
						<div key={todo.id} className="todo-item" role="listitem">
							<button
								className="todo-status-toggle"
								onClick={() => onTodoToggle(todo.id)}
								title={
									todo.status === "completed" ? "Mark as not started" :
									todo.status === "in-progress" ? "Mark as completed" :
									"Mark as in progress"
								}
								aria-label={`${todo.title}, ${todo.status}`}
							>
								{todo.status === "completed" && <CheckIcon />}
								{todo.status === "in-progress" && <RecordIcon />}
								{todo.status === "not-started" && <CircleIcon />}
							</button>
							<span className={`todo-item-title ${todo.status === "completed" ? "done" : ""}`}>
								{todo.title}
							</span>
							<span className="todo-item-status">{todo.status}</span>
							<div className="todo-item-actions">
								<button
									className="todo-move-btn"
									onClick={() => onMoveUp(todo.id)}
									disabled={todo.id === todos[0]?.id}
									title="Move up"
									aria-label="Move up"
								>
									<ChevronUpIcon />
								</button>
								<button
									className="todo-move-btn"
									onClick={() => onMoveDown(todo.id)}
									disabled={todo.id === todos[todos.length - 1]?.id}
									title="Move down"
									aria-label="Move down"
								>
									<ChevronDownIcon />
								</button>
							</div>
						</div>
					))}
				</div>
			)}
		</div>
	);
}

// ── Helper SVG Icons ───────────────────────────────────────────

function CheckIcon() {
	return (
		<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--vscode-charts-green, #2ea043)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
			<circle cx="12" cy="12" r="10" />
			<path d="M9 12l2 2 4-4" />
		</svg>
	);
}

function RecordIcon() {
	return (
		<svg width="14" height="14" viewBox="0 0 24 24" fill="var(--vscode-charts-blue, #58a6ff)" stroke="none">
			<circle cx="12" cy="12" r="10" />
			<circle cx="12" cy="12" r="4" fill="var(--vscode-charts-blue, #58a6ff)" />
		</svg>
	);
}

function CircleIcon() {
	return (
		<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted, #8b949e)" strokeWidth="2">
			<circle cx="12" cy="12" r="10" />
		</svg>
	);
}

function ClearIcon() {
	return (
		<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
			<line x1="18" y1="6" x2="6" y2="18" />
			<line x1="6" y1="6" x2="18" y2="18" />
		</svg>
	);
}

function ChevronUpIcon() {
	return (
		<svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
			<polyline points="18 15 12 9 6 15" />
		</svg>
	);
}

function ChevronDownIcon() {
	return (
		<svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
			<polyline points="6 9 12 15 18 9" />
		</svg>
	);
}
