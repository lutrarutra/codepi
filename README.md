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
npm run compile      # build both webview + extension into dist/
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
