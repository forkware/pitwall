# Architecture

Pitwall is a manager for AI coding agents that every user can change. A user who wants something different does not open an issue upstream and wait: they press **Customize the app**, tell an agent what they want, and the agent changes their own fork. Changes that many forks make move into upstream (rules 8 and 4 of the [manifesto](forkware/manifesto.md)).

## Narrow core, wide edges

```
plugins/              the edges: everything a user is likely to change
  claude-code/        agent provider: runs the claude CLI
  local-dir/          binds a folder to a directory
  customize-app/      the "Customize the app" button and its LangGraph process
  example-flow/       example processes for folder task buttons: a form, progress, an agent, a note
  <yours>/            what an agent wrote for this fork
src/                  the core: knows folders, tasks, statuses and agent sessions, nothing else
```

For now core and app share one repository. The boundary is the directory: `src/` is the core, `plugins/` are the edges, and plugins talk to the core only through `#sdk/server` and `#sdk/ui`. Once the API settles, `src/` becomes a package of its own and forks get core updates the way they get any dependency, without merging anyone's diffs.

## One server, two ways to open it

```
                ┌────────────── Node process (src/cli.ts) ──────────────┐
 Electron  ───► │ HTTP: UI (Vite live, or dist/ui with --built), /api   │
 window         │ WebSocket /ws: events, terminal streams               │
                │ core: store · status model · sessions (node-pty)      │
 Browser   ───► │ plugins/*/server.ts                                   │
 (--server)     │ SQLite (node:sqlite) in the user's data directory     │
                └───────────────────────────────────────────────────────┘
```

- `pnpm start` starts the server on 127.0.0.1 with a one-time token and opens an Electron window on it.
- `pnpm start --server [--host H] [--port P]` starts the same server alone and prints a link carrying the token.

The UI never talks to Electron, only to `/api` and `/ws`, so both modes run the same code. Electron is only a window: the server runs on the system's Node, so the native `node-pty` module is built once, for one ABI.

The server is a remote shell for whoever holds the token: agents run commands. It listens on 127.0.0.1 unless told otherwise, and every request needs the token (once in the link, then an HttpOnly cookie, or a Bearer header).

## Core

| | |
|---|---|
| Folders | A tree. A folder holds subfolders and tasks. Its meaning (a git repository, a directory, a schedule) comes from plugins through `meta[<plugin id>]`. |
| Tasks | Title, body, status, `meta`. |
| Status model | A registry of statuses with a category (`open`, `active`, `done`); the core ships `todo → in_progress → done`. A change of status runs the plugins' guards, which can refuse it, then emits `task.status.changed`. Processes are built on these two. |
| Sessions | An agent CLI in a pseudo-terminal. A task can run several. Output is kept in memory for attaching clients and in a log file per session. |
| Providers | Plugins register agent CLIs: command and arguments. Users use their own subscriptions and logins; the app never holds API keys. |
| Processes | Plugins register steps (reusable units that declare the state keys they read and write) and processes (graphs of steps). The core checks that contract, runs a task's process with LangGraph, keeps its checkpoints in SQLite and stops where a step asks the user. A task follows one process. A folder's `taskProcesses` setting lists the processes its task buttons and hotkeys create tasks with. |
| Workspaces | Plugins decide which directory an agent starts in; otherwise it gets a scratch directory. |
| Settings | Defined by the core and plugins, each with a type and a default. An app value comes from `--set`, then `PITWALL_<KEY>`, then `settings.json` in the data directory, then the default. Settings marked `folder` are overridden per folder and inherited by subfolders. |
| Audit | Every plugin write is recorded. A write without the permission declared in `plugin.json` goes through but raises an alarm (rule 7). |

## Plugins

`plugins/<id>/` holds `plugin.json` (name, permissions with reasons), `server.ts`, `ui.tsx`, `RECIPE.md` and `tests/`. The server loads them at start; Vite finds the UI parts at build time with `import.meta.glob`, with full types and live reload.

UI slots: `header.actions`, `sidebar.header`, `folder.badge`, `folder.menu`, `folder.settings`, `task.badge`, `task.menu`, `task.header`, `session.toolbar`. Plugins build from the core's kit and design tokens, so additions look native in both themes.

Processes are [LangGraph](https://langchain-ai.github.io/langgraphjs/) graphs of steps, both registered by plugins (`ctx.steps`, `ctx.processes`). Steps are separate from processes so several processes reuse them; their state is namespaced (`git.workspace`, `github.issue`) and each step declares what it reads and writes. `customize-app` still builds its own one-node graph and moves to steps later.

## Stack

Node 22.18+ running TypeScript directly · `node:sqlite` · `@lydell/node-pty` · `ws` · React 19, Vite, Tailwind 4, Radix, lucide · xterm.js · Electron · LangGraph · Vitest.

## Known limits

- Restarting the server ends running agent sessions, including the one that is changing the app. Next step: a separate process that keeps the terminals.
- Server plugins load at start; changing one needs a restart. UI plugins reload live.
- Windows is untested.
