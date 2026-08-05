# CodePi

A VS Code extension that embeds the [pi coding agent](https://pi.dev) in an editor-native chat panel.

> **Third-party notice:** CodePi is an independent extension. It is not affiliated with, endorsed by, sponsored by, or maintained by pi.dev or the pi project.

## What CodePi adds to pi

### VS Code-native agent experience

- Embedded pi runtime with streaming chat, tool calls, thinking levels, markdown, syntax highlighting, and a terminal-backed TUI.
- Persistent sessions in a VS Code sidebar: create, reopen, rename, delete, refresh, and restore sessions after reloads.
- Sessions and runtime state stored in VS Code extension storage; pi resources remain available from `~/.pi/agent`.
- VS Code webview terminal with configurable font family and size. Fira Code Nerd Font is bundled by default.
- Sessions work in local and Remote-SSH windows without sharing session files between machines.

### Editor context

The agent receives a session-start `<editor_context>` snapshot and can refresh it live with:

- Active file, language, cursor, selections, and selection text.
- Open editors, recently visited files, dirty state, workspace folders, trust state, and open terminals.
- Git repositories, branches, changed files, line counts, and the SCM commit box.
- Active debug session.
- `get_editor_context` for a live combined snapshot.
- `get_git_diff` for unified diffs, including untracked files.
- Live context updates when the active file or selection changes.

### Workspace tools

CodePi provides VS Code-aware tools for:

- `read` — read text files and images.
- `head` — preview the first lines of a file.
- `write` — create or overwrite files.
- `edit` — apply targeted replacements.
- `ls` — list directory contents.
- `find` — find files using VS Code's file index and globs.
- `grep` — search file contents with regex, case sensitivity, and include/exclude globs.
- `get_diagnostics` — read Problems-panel diagnostics from language servers and problem matchers.

### Edit review

Agent edits are written to disk immediately and tracked for review:

- Added/removed line decorations and a review bar in the editor.
- Per-hunk, per-file, and accept-all/reject-all actions.
- CodeLens actions, diff views, edit cards in chat, and a pending-edits status bar.
- Changes made manually while a proposal is pending are marked stale instead of being overwritten.
- `/filechanges` provides a session-level change log; accept or decline changes with `/filechanges-accept` and `/filechanges-decline`.
- Editor review state and the file-change tracker stay synchronized.

### Agent modes

Switch with `/codepi-ask`, `/codepi-plan`, and `/codepi-implement`:

- **Ask** — read-only mode; editing, shell commands, and non-whitelisted tools are blocked.
- **Plan** — planning mode; explore the project and write Markdown plans without changing source code.
- **Implement** — full tool access.

Ask-mode tools are configurable with `codepi.modes.ask.allowedTools`.

### VS Code terminal bash

The bundled `codepi-bash` extension replaces pi's stock bash tool with execution through a hidden VS Code terminal:

- `ask` mode with approval, denial, revision, or auto-approve options.
- `allow` mode for automatic execution.
- `disabled` mode to block shell commands.
- Shell integration, timeouts, output truncation, and temp-file spillover for large output.
- Toggle with `/codepi-bash-ask`, `/codepi-bash-allow`, and `/codepi-bash-disable`.
- `codepi-task-run` uses the same terminal backend for saved project tasks.

### Reusable project tasks

Define build, test, lint, package, and other commands in `.pi/tasks.json`:

- `codepi-task-create`, `codepi-task-edit`, `codepi-task-delete`
- `codepi-task-run`, `codepi-task-list`
- `before-implement`, `after-implement`, and `anytime` task timing.
- Read-only tasks can run in Ask mode.
- Task changes require user confirmation and task output uses the VS Code terminal backend.

### TL;DR mode and footer

- TL;DR mode collapses streaming thoughts and tool activity into a compact summary row while preserving the final response.
- Toggle with `/codepi-toggle-tldr`; enabled by default and persisted per session.
- Custom footer with token usage, reasoning tokens, cost, context usage, tokens/sec, model, thinking level, mode, bash approval state, and Git branch.
- Bundled `nebula-pulse` theme and Nerd Font icons.

### Verification and workflow automation

- Automatic post-edit diagnostics via `codepi.autoVerify`: `nextTurn`, `followUp`, or `off`.
- `nextTurn` quietly adds problems to the next prompt; `followUp` asks pi to fix them immediately.
- A `codepi` command in VS Code's integrated terminal opens a new CodePi session. It is scoped to VS Code terminals and can be disabled with `codepi.terminalShortcut: false`.

### Settings and extension management

The CodePi sidebar includes:

- Sessions, Settings, and Extensions views.
- Bundled-resource toggles for `codepi-footer`, `codepi-diff`, `codepi-modes`, `codepi-bash`, `codepi-context`, `codepi-task`, and `nebula-pulse`.
- Links to pi's `settings.json`, `models.json`, and `auth.json`.
- A live inventory of loaded core, bundled, project, user, and package extensions, commands, tools, handlers, flags, shortcuts, and message renderers.
- Configuration for terminal font, terminal size, TL;DR mode, auto-verify, terminal shortcut, and Ask-mode tools.

CodePi also loads pi's normal resources and extension ecosystem: configured models and providers, authentication, skills, prompt templates, themes, packages, and custom extensions.

## Requirements

- VS Code 1.93 or newer.
- A pi configuration in `~/.pi/agent`, or the resources needed by your configured provider.

## Development

```bash
npm install
npm --prefix webview-ui install
npm run build       # build the webview and extension
npm test            # run tests
make verify         # type-check, test, and smoke-test
make vsix           # build a VSIX package
```

For watch mode:

```bash
npm run watch
```

## License

MIT
