/**
 * Todo Tool — Manages a structured todo list for task planning and tracking.
 *
 * Design follows VS Code Copilot's manageTodoListTool:
 * - The ENTIRE list is sent every time (not individual add/toggle actions)
 * - Three states: not-started, in-progress, completed
 * - State stored in module-level variable, reconstructed from session on load
 */

import type { VscodeTool, VscodeToolArgs } from "./index";

// ── Types ──────────────────────────────────────────────────────

export interface TodoItem {
    id: number;
    title: string;
    status: "not-started" | "in-progress" | "completed";
}

export interface TodoDetails {
    action: "write";
    todoList: TodoItem[];
}

// ── Module-level state ─────────────────────────────────────────

let currentTodoList: TodoItem[] = [];

export function getTodoList(): TodoItem[] {
    return [...currentTodoList];
}

export function setTodoList(list: TodoItem[]): void {
    currentTodoList = list;
}

export function clearTodoList(): void {
    currentTodoList = [];
}

/**
 * Reconstruct todos from session entries by scanning for the last `todo` tool result.
 */
export function reconstructFromEntries(entries: Array<{ type: string; [key: string]: any }>): void {
    currentTodoList = [];
    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (entry.type !== "message") continue;
        const msg = entry.message;
        if (msg?.role !== "toolResult" || msg?.toolName !== "todo") continue;
        const details = msg.details as TodoDetails | undefined;
        if (details?.todoList) {
            currentTodoList = details.todoList;
            break; // Use the most recent todo tool result
        }
    }
}

// ── Tool Definition ────────────────────────────────────────────

export const todoTool: VscodeTool = {
    name: "todo",
    label: "Todo",
    description:
        "Manage a structured todo list to track progress and plan tasks. " +
        "Use this tool frequently for complex multi-step work. " +
        "The ENTIRE todo list must be sent every time. " +
        "At most ONE todo should be in-progress at a time. " +
        "Mark todos completed IMMEDIATELY after finishing each one. " +
        "Do NOT batch completions — mark each complete as you go.",
    parameters: {
        type: "object",
        properties: {
            todoList: {
                type: "array",
                description: "Complete array of ALL todo items — existing, new, and updated.",
                items: {
                    type: "object",
                    properties: {
                        id: {
                            type: "number",
                            description: "Unique sequential identifier starting from 1.",
                        },
                        title: {
                            type: "string",
                            description: "Concise action-oriented label (3-7 words).",
                        },
                        status: {
                            type: "string",
                            enum: ["not-started", "in-progress", "completed"],
                            description:
                                "not-started: not yet begun | in-progress: currently working (max 1) | completed: finished",
                        },
                    },
                    required: ["id", "title", "status"],
                },
            },
        },
        required: ["todoList"],
    },

    async execute(_toolCallId: string, params: VscodeToolArgs): Promise<any> {
        const args = params as { todoList?: TodoItem[] };
        const newList = args.todoList ?? [];

        // Validate: at most one in-progress
        const inProgress = newList.filter((t) => t.status === "in-progress");
        if (inProgress.length > 1) {
            // Auto-fix: keep only the first in-progress, convert others to not-started
            let found = false;
            for (const t of newList) {
                if (t.status === "in-progress") {
                    if (found) t.status = "not-started";
                    else found = true;
                }
            }
        }

        const oldCount = currentTodoList.length;
        currentTodoList = newList;

        // Generate a descriptive past-tense-style message
        let message = "Updated todo list";
        if (oldCount === 0 && newList.length > 0) {
            message =
                newList.length === 1 ? "Created 1 todo" : `Created ${newList.length} todos`;
        } else {
            const inProg = newList.find((t) => t.status === "in-progress");
            const justCompleted = newList.find((t) => t.status === "completed");
            if (inProg) {
                const idx = newList.indexOf(inProg) + 1;
                message = `Starting: ${inProg.title} (${idx}/${newList.length})`;
            } else if (justCompleted) {
                const idx = newList.indexOf(justCompleted) + 1;
                message = `Completed: ${justCompleted.title} (${idx}/${newList.length})`;
            }
        }

        return {
            content: [{ type: "text" as const, text: message }],
            details: { action: "write", todoList: newList } as TodoDetails,
        };
    },
};
