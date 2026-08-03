# CodePI Modes — Implementation Plan

## Overview

A bundled PI extension (`codepi-modes`) that implements three agent modes:
**Ask** (read-only), **Plan** (planning-focused, write-limited), and **Implement** (full access, default).

The extension lives at `resources/extensions/codepi-modes.ts` and is loaded like the existing `custom-footer.ts` and `filechanges.ts` bundled extensions.

---

## Architecture

### Mode State Machine

Mode switching is a **user action** — any transition is allowed from the commands.
The only gate is Plan → Implement's "are you satisfied with the plan?" confirmation.
The restrictions below apply to the **agent only** (via system-prompt instructions):

```
                    ┌──────────┐
          default──▶│IMPLEMENT │◀──────────────┐
                    └──┬───┬──┘               │
                       │   │                  │
              /codepi- │   │ /codepi-plan     │ /codepi-implement
                ask    │   ▼                  │ (with confirmation)
                       │  ┌──────────┐        │
                       │  │   PLAN   │────────┘
                       │  └──────────┘
                       ▼
                    ┌──────────┐
                    │   ASK    │
                    └──────────┘
```

**Rules:**
- **User commands** (`/codepi-ask`, `/codepi-plan`, `/codepi-implement`): any transition always allowed, in any direction, at any point. No-op when already in the target mode.
- **Plan → Implement**: shows a `ctx.ui.confirm()` "satisfied with the plan?" checkpoint before switching.
- **Agent-side restrictions** (system prompt only, never blocking the user):
  - In Ask mode the agent cannot switch modes itself and must direct the user to run `/codepi-plan` or `/codepi-implement`.
  - In Plan mode the agent focuses on planning and does not suggest dropping to Ask mode (plan mode already asks clarifying questions); when the plan is confirmed it directs the user to `/codepi-implement`.
- New sessions always start in **Implement** mode

---

## Mode Behaviors

### 1. Ask Mode (Read-Only)

**Enforcement: read-only allowlist** — every tool call is gated by
`pi.on("tool_call")`, which blocks with `{ block: true, reason: "..." }` anything
that is NOT in the Ask-mode allowlist:

- **Defaults (seeded into settings.json on activation; runtime fallback when
  the block is missing):** `read`, `grep`, `find`, `ls` (the SDK's canonical
  read-only set) + CodePi host tools `list_dir`, `find_files`,
  `get_diagnostics`, `ask_user_question` + read-only web tools `web_search`,
  `fetch_content`.
- **Blocked by default:** `edit`, `write`, shell commands (`bash`), and every
  third-party/extension tool (e.g. `subagent`, `intercom`, `todo`).
- **User whitelist:** `codepi.modes.ask.allowedTools` in settings.json — the
  source of truth when present; an explicitly empty list is respected. The
  settings block is seeded with the defaults on first activation, and is
  editable from the CodePi Settings view ("Ask mode tools" field) or directly
  in settings.json. Re-read from disk on every tool call, so edits apply
  immediately. When the block is missing entirely, the hardcoded defaults are
  used (keep `ASK_MODE_DEFAULT_ALLOWED_TOOLS` in src/pi-store.ts in sync with
  `DEFAULT_ASK_ALLOWED_TOOLS` in resources/extensions/codepi-modes.ts).

```json
{
  "codepi": {
    "modes": {
      "ask": {
        "allowedTools": [
          "read", "grep", "find", "ls",
          "list_dir", "find_files", "get_diagnostics", "ask_user_question",
          "web_search", "fetch_content"
        ]
      }
    }
  }
}
```

Tools are NOT removed from the registry in Ask mode: blocking happens at call
 time so the model gets a clear reason instead of an opaque "tool not found"
 error from stale context (`ensureWriteToolsPresent` heals sessions that
 stripped tools under older behavior).

**System prompt injection** (via `before_agent_start`):
```
## MODE: ASK (Read-Only)

You are in **read-only mode**. You can read files, search code, run diagnostics,
and answer questions — but you CANNOT edit or create files.

- Use `read`, `grep`, `find`, `ls`, `bash` (for diagnostics/search only) freely
- Do NOT suggest edits or implementations — instead, tell the user to switch to
  Implement mode if they need code changes
- If asked to implement something, respond: "I'm in Ask (read-only) mode. Switch to
  Implement mode with `/codepi-implement` if you want me to make changes."
- If asked to plan or implement, respond: "I'm in Ask (read-only) mode. Open a new
  session if you need planning or implementation capabilities."
```

**User-facing notification:** When switching to ask mode, notify via `ctx.ui.notify()`

### 2. Plan Mode (Planning-Focused)

**Tools available:** All tools (including `edit`, `write`)

**System prompt injection** (via `before_agent_start`):
```
## MODE: PLAN (Planning)

You are in **planning mode**. Your goal is to analyze, brainstorm, and create
detailed plans — not to implement them.

Workflow:
1. **Brainstorm**: Explore the codebase, understand the current implementation
2. **Clarify**: Ask the user clarifying questions using the `ask_user_question` tool
3. **Document**: Write your plan to markdown files (e.g., `docs/plans/<feature>.md`)
4. **Track**: Add implementation todos using the `todo` tool
5. **Confirm**: When the plan is complete, ask the user if they're satisfied

Rules:
- You MAY read any files, search code, browse the project
- You MAY write/edit plan files: markdown (.md), documentation, notes
- You MAY add/update todos via the `todo` tool
- You MUST NOT implement features, fix bugs, or modify source code
- You MUST NOT edit non-documentation files (.ts, .js, .json, .py, etc.)
- At the end of planning, ask: "Are you satisfied with this plan? If so, I'll switch
  to Implement mode."
- If the user is satisfied, call `/codepi-implement` to switch modes
```

**User-facing notification:** When switching, notify the user about the planning workflow

### 3. Implement Mode (Default)

**Tools available:** All tools (no restrictions)

**System prompt injection:** None — this is pi's default behavior. No prompt modifications.

**Footer badge:** Green "IMPLEMENT"

---

## Footer Indicator

The custom footer from `custom-footer.ts` is replaced/augmented. The mode badge is appended to the far right of the footer.

**Colors (from pi theme tokens):**
- **ASK**: `theme.fg("info", " ASK ")` — blue badge
- **PLAN**: `theme.fg("warning", " PLAN ")` — yellow/amber badge
- **IMPLEMENT**: `theme.fg("success", " IMPLEMENT ")` — green badge

**Format:** `… │ ASK` or `… │ PLAN` or `… │ IMPLEMENT`

The badge is always visible when `codepi-modes` is active.

---

## Commands

### `/codepi-ask`
Switches to Ask (read-only) mode.
- Blocks edit/write tools
- Injects ask-mode system prompt
- Notifies user
- Accessible from: **Implement, Plan**

### `/codepi-plan`
Switches to Plan mode.
- Allows all tools, instructs agent to focus on planning
- Injects plan-mode system prompt
- Notifies user
- Accessible from: **Implement** only

### `/codepi-implement`
Switches to Implement (default) mode.
- Removes all restrictions
- Removes mode-specific system prompt
- Accessible from: **Plan** (with confirmation); **Ask** (blocked)

---

## Implementation Details

### File: `resources/extensions/codepi-modes.ts`

#### 1. Mode State Persistence

Modes are stored as custom session entries:
```ts
type Mode = "ask" | "plan" | "implement";

// Persist
pi.appendEntry("codepi-modes:mode", { mode: "ask", timestamp: Date.now() });

// Read on session_start
for (const entry of ctx.sessionManager.getBranch()) {
  if (entry.type === "custom" && entry.customType === "codepi-modes:mode") {
    currentMode = (entry.data as any).mode;
  }
}
```

The latest entry wins on `session_start` replay.

#### 2. Tool Blocking (Ask Mode)

```ts
pi.on("tool_call", async (event, ctx) => {
  if (currentMode !== "ask") return;
  const allowlist = getAskModeAllowlist(readAskAllowedTools());
  if (!allowlist.has(event.toolName)) {
    if (ctx.hasUI) {
      ctx.ui.notify(
        "Ask mode is read-only. Switch to Implement mode with /codepi-implement to edit files.",
        "warning"
      );
    }
    return { block: true, reason: "Ask mode: read-only. Use /codepi-implement to edit files." };
  }
});
```

Tools stay registered in ask mode; `ensureWriteToolsPresent()` heals any session that stripped them under older behavior.

#### 3. System Prompt Injection

```ts
pi.on("before_agent_start", async (event, ctx) => {
  if (currentMode === "implement") return; // No prompt modification
  const modeInstructions = getModeInstructions(currentMode);
  return { systemPrompt: event.systemPrompt + "\n\n" + modeInstructions };
});
```

`getModeInstructions()` returns the appropriate markdown block from the mode behaviors section above.

#### 4. Footer Integration

The custom footer needs to augment the existing footer. Since the `custom-footer.ts` extension already owns `setFooter()`, we have two options:

**Option A**: Integrate into `custom-footer.ts` (modify existing extension)
**Option B**: Coordinate between extensions via custom session entries

**Decision: Option A** — modify `custom-footer.ts` to include the mode badge. The `codepi-modes.ts` extension publishes mode state via `pi.appendEntry("codepi-modes:mode", ...)`, and the footer reads it via `ctx.sessionManager.getBranch()` polling (already done for git branch).

#### 5. Mode Switching Logic

```ts
// All commands share one transition gate. Mode switching is a user action:
// every transition is allowed, the only checkpoint is Plan → Implement.
async function transitionTo(target: Mode, ctx: ExtensionCommandContext) {
  await ctx.waitForIdle();

  // No-op when already in the target mode.
  if (currentMode === target) {
    ctx.ui.notify(`Already in ${labels[target]}.`, "info");
    return;
  }

  // Plan → Implement keeps the "are you satisfied with the plan?" checkpoint.
  if (currentMode === "plan" && target === "implement" && ctx.hasUI) {
    const confirmed = await ctx.ui.confirm(
      "Switch to Implement mode?",
      "This will give the agent full read/write access to start implementing the plan."
    );
    if (!confirmed) {
      ctx.ui.notify("Stayed in Plan mode.", "info");
      return;
    }
  }

  setMode(target, ctx);
  ctx.ui.notify(`Switched to ${labels[target]}.`, "info");
}

pi.registerCommand("codepi-ask", {
  description: "Switch to Ask mode (read-only)",
  handler: async (_args, ctx) => transitionTo("ask", ctx),
});

pi.registerCommand("codepi-plan", {
  description: "Switch to Plan mode (planning, no implementation)",
  handler: async (_args, ctx) => transitionTo("plan", ctx),
});

pi.registerCommand("codepi-implement", {
  description: "Switch to Implement mode (full access)",
  handler: async (_args, ctx) => transitionTo("implement", ctx),
});
```

#### 6. `setMode()` Helper

```ts
function setMode(mode: Mode, ctx: ExtensionContext): void {
  currentMode = mode;
  
  // Persist to session
  pi.appendEntry("codepi-modes:mode", { mode, timestamp: Date.now() });
  
  // Tool management for ask mode
  if (mode === "ask") {
    const tools = pi.getActiveTools();
    pi.setActiveTools(tools.filter(t => t !== "edit" && t !== "write"));
  } else {
    // Restore all tools (implement/plan)
    const currentTools = pi.getActiveTools();
    if (!currentTools.includes("edit") || !currentTools.includes("write")) {
      pi.setActiveTools([...new Set([...currentTools, "edit", "write"])]);
    }
  }
  
  // Notify
  const labels: Record<Mode, string> = {
    ask: "Ask mode (read-only)",
    plan: "Plan mode (planning only)",
    implement: "Implement mode (full access)",
  };
  ctx.ui.notify(`Switched to ${labels[mode]}.`, "info");
  
  // Trigger footer update
  updateFooter(ctx);
}
```

### Files to Modify

| File | Change |
|------|--------|
| `resources/extensions/codepi-modes.ts` | **NEW** — Main modes extension |
| `resources/extensions/custom-footer.ts` | **MODIFY** — Add mode badge to far right of footer |
| `src/pi-runtime-config.ts` | **MODIFY** — Add `codepi-modes` to bundled extension paths |
| `src/pi-store.ts` | **MODIFY** — Add `codepi-modes` to `BUNDLED_RESOURCES` metadata |
| `resources/extensions/ambient.d.ts` | **MODIFY** (if needed) — Any additional type declarations |

### Settings (codepi-modes defaults)

Added to `BUNDLED_RESOURCES`:
```ts
{
  id: "codepi-modes",
  label: "Agent modes (Ask / Plan / Implement)",
  kind: "extension",
  enabledByDefault: true,
}
```

---

## Edge Cases & Open Questions

1. **Footer coordination**: `custom-footer.ts` and `codepi-modes.ts` both want to set the footer. Since the footer is a singleton (last `setFooter()` wins), modes should integrate into the existing footer component rather than fighting over it. The cleanest approach: modes stores state in custom entries, footer reads it.

2. **Mode during `session_start` replay**: On session reload, the extension replays custom entries to recover the last mode. The `session_start` handler should also re-apply tool restrictions based on the recovered mode.

3. **`/codepi-ask` from within Ask mode**: No-op (already in ask mode).

4. **`/codepi-plan` from within Ask mode**: Allowed — the user can upgrade from ask to plan at any point. The agent itself cannot switch modes; it directs the user to run the command.

5. **`/codepi-plan` from within Plan mode**: No-op (already in plan mode).

6. **Mode indicator visibility**: If `codepi-modes` extension is disabled in settings, no mode badge appears in the footer. If enabled but in implement mode, a green "IMPLEMENT" badge is always shown (per user preference for colored badge).

7. **Compact message on Plan mode completion**: When the plan is done, the agent should use `ask_user_question` to confirm satisfaction. The "Are you satisfied?" question should have options like "Yes, switch to Implement" and "No, revise the plan."

---

## Testing

- Unit tests for mode state machine logic
- Test tool blocking in ask mode
- Test system prompt injection
- Test mode switching rules (ask can't leave, plan needs confirmation)
- Test mode persistence across session reload
