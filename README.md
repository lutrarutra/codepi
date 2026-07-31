# CodePi

A minimal VSCode extension starter with a **React + TypeScript** webview (frontend) and a **TypeScript** extension host (backend).

## Project structure

```
codepi/
├── src/                  # Backend: VSCode extension host (TypeScript)
│   └── extension.ts      #   entry point, registers commands + webview
├── webview-ui/           # Frontend: React app rendered in the webview
│   ├── src/
│   │   ├── main.tsx      #   React bootstrap
│   │   ├── App.tsx       #   main UI + messaging to/from backend
│   │   └── index.css     #   VSCode-theme-aware styling
│   ├── index.html
│   ├── vite.config.ts     #   fixed output names referenced by extension.ts
│   └── tsconfig.json
├── esbuild.mjs           # Backend bundler (esbuild)
├── tsconfig.json         # Backend tsconfig
└── package.json          # Extension manifest
```

## Setup

```bash
npm install          # root deps (backend)
npm --prefix webview-ui install   # webview deps (frontend)
```

## Build

```bash
npm run build      # build both webview + extension into dist/
```

Or watch during development:

```bash
npm run watch        # watches both webview and extension concurrently
```

## Run / Debug

Open the project in VSCode and press **F5**
(launch config `.vscode/launch.json` starts an Extension Development Host
after running the watch task). Then run the command **CodePi: Open Panel**
from the Command Palette (`Ctrl/Cmd+Shift+P`).

## How frontend ↔ backend messaging works

**Frontend → Backend:** call `vscode.postMessage({ command, ... })`
(see `webview-ui/src/App.tsx`).

**Backend → Frontend:** call `panel.webview.postMessage({ command, ... })`
and listen with `panel.webview.onDidReceiveMessage(...)` in
`src/extension.ts`. The webview listens via `window.addEventListener("message", ...)`.

## Edit review (Copilot-style inline diffs)

When the agent calls the `write` or `edit` tool, the change is **applied and
saved immediately** (matching VS Code Copilot), then tracked for review:

- The file opens in the editor with **green** decorations on added lines and
  **red** decorations (plus a preview) where lines were removed.
- A **review bar at the top of the file** asks the whole-file question:
  `📝 N changes — Accept All · Reject All · Open Diff` (hover the bar for
  clickable buttons; the same actions appear as CodeLens at the top when
  `editor.codeLens` is enabled).
- **Each changed snippet** gets its own question: an `✓ Accept  ✕ Reject` pill
  at the end of the snippet's last line, with clickable Accept/Reject buttons
  on hover (and per-hunk CodeLens actions).
- A **bottom-right notification** asks you to `Accept` or `Decline` changes
  **file by file**, in order, and a **status-bar item** shows how many files /
  edits are pending (click it to jump to a pending file).
- The chat panel shows an **Edit Review bar** (per-file `Accept`/`Reject` and
  cross-file `Accept All` / `Reject All`) plus a per-edit **EditCard** in the
  tool result.
- `Open Diff` opens a side-by-side diff of the original vs. proposed content.
- If you edit the file yourself while a proposal is pending, the proposal is
  marked **stale** and nothing is overwritten.

Implementation lives in `src/review/` (`review-manager.ts` owns proposals and
hunk resolution, `diff.ts` computes line hunks, `decorations.ts` renders the
editor UI — review bar, snippet pills, hover actions, CodeLens — and
`edit-apply.ts` applies `oldText`/`newText` edits).
