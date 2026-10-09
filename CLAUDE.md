# Pitwall

A manager for AI coding agents, built by the rules in [forkware/manifesto.md](forkware/manifesto.md). Users install it as their own fork and change it by asking an agent, usually through the "Customize the app" button, which starts you in this directory.

## Ground rules

- **Every change starts with an issue** in this repository (`gh issue create`). Say what the user asked for in their words.
- **Change the app through a plugin** in `plugins/<id>/` whenever the plugin API allows it. Touch `src/` only when the core is missing an extension point, and then add the extension point, not the feature.
- **Each plugin carries a recipe**: `RECIPE.md` with the intent, a short spec and how to check it. The diff can go stale, the intent stays.
- **Tests are the contract.** Add tests next to the plugin (`plugins/<id>/tests/*.test.ts`). Before you finish: `pnpm run check && pnpm test`.
- **Do not restart the app yourself.** It runs your terminal session. UI changes reload by themselves; for server changes, ask the user to restart.

## Commands

| | |
|---|---|
| `pnpm start` | Desktop window (Electron showing the local server's page) |
| `pnpm run server` | Web server on 127.0.0.1:4870; prints a link with the login token |
| `pnpm start --server --host 0.0.0.0 --port 8080` | Server reachable from the network |
| `pnpm test` | Vitest: core and plugin tests |
| `pnpm run check` | TypeScript |
| `pnpm run build` | Build the UI into `dist/ui` for `--built` |

Settings: the gear in the top bar, or `<data dir>/settings.json`, or `PITWALL_<KEY>=value` (`defaultProvider` → `PITWALL_DEFAULT_PROVIDER`), or `--set key=value`; the later win. Settings defined with `folder: true` can be overridden on a folder's page and are inherited by subfolders.

Data lives outside the repository: `~/.local/share/forkware-pitwall` on Linux (SQLite database, session logs). `--data-dir` or `PITWALL_DATA_DIR` moves it.

## Layout

```
src/cli.ts           entry: --server or the desktop window
src/server/          the core: store (folders, tasks, statuses), sessions (PTYs), plugins, http
src/sdk/             types and definePlugin: the contract for plugins' server parts
src/ui/              React UI; sdk.tsx is what plugins' UI parts import as "#sdk/ui"
src/desktop/main.cjs the Electron window; no logic there (preload.cjs: OS services for the page)
plugins/<id>/        plugin.json, server.ts, ui.tsx, RECIPE.md, tests/
```

The server runs TypeScript directly through Node's type stripping: no enums, no parameter properties, no namespaces, and relative imports end in `.ts`.

## Writing a plugin

`plugins/<id>/plugin.json`:

```json
{
  "name": "Review step",
  "description": "Adds a Review status that tasks must pass before Done.",
  "permissions": {
    "statuses:register": "Adds the Review status.",
    "tasks:guard": "Blocks Done until the task was in Review."
  }
}
```

Permissions: `folders:write`, `tasks:write`, `tasks:guard`, `statuses:register`, `agents:provide`, `agents:spawn`, `workspaces:resolve`, `steps:register`, `processes:register`, `processes:run`. Reads need none. A write without its permission still works but is recorded and raises an alarm in the UI (rule 7), so declare what you use and say why.

`plugins/<id>/server.ts`:

```ts
import { definePlugin } from "#sdk/server";

export default definePlugin((ctx) => {
  ctx.statuses.register([{ id: "review", label: "Review", color: "amber", category: "active" }]);
  ctx.tasks.guardTransition((task, from, to) => (to === "done" && from !== "review" ? "Review it first" : true));
  ctx.events.on("session.exited", ({ taskId }) => ctx.log("agent finished", taskId));
  ctx.rpc.handle("ping", () => "pong"); // the UI calls rpc("<id>", "ping")
});
```

The full context is in `src/sdk/server.ts`: `events`, `statuses`, `folders`, `tasks`, `agents` (providers and sessions), `workspaces` (which directory an agent starts in), `settings`, `rpc`, `kv`.

Agents:
- `ctx.agents.send(sessionId, text)` types a message into a running agent;
- `ctx.agents.run(prompt, { folderId, cwd })` runs one once without a terminal (its provider's `exec`) and resolves to its answer; with `fallback: "session"` an agent that has no `exec` (or whose `exec` failed) runs in a terminal nobody sees and answers with `pitwall answer`, asks with `pitwall ask` (`onAsk`, `run.reply`) and reports with `pitwall progress` (`onProgress`); `onStart` gives the run (its `sessionId` for `AgentTerminal` in `#sdk/ui`, `extend`, `stop`, `ask` with `keep: true`), `onActivity` its silence and permission prompts, `timeoutMs` its deadline (a failure carries `screen`);
- `ctx.agents.providers()` lists the agents, with `available` and `exec`;
- `ctx.agents.screen(sessionId)` gives the end of its screen as text;
- `ctx.agents.stop(sessionId)` ends it (before removing the directory it runs in, say).
- `ctx.tasks.delete(id)` deletes a task for good (a trial run's, say).
- A session has `busy`, `lastOutputAt`, `lastInputAt` (the user typing), `asking` (quiet on a prompt its provider's `asks(screen)` recognizes) and `waiting` (quiet until it goes on by itself, Claude's usage limit, as its provider's `waits(screen)` recognizes; busy too, so nobody asks it whether it finished, but a restart does not wait for it).
- An agent tells the app about its task with the `pitwall <name> [text]` command (`bin/`, put in its PATH); a plugin answers with `ctx.agents.onSignal({ name, description, handler })`, and `pitwall help` lists them.

A task's `workspace` (`ctx.tasks.update(id, { workspace })`) is where its agents start, before the folder's directory; `ctx.workspaces.ofFolder(taskId)` is the folder's.

Settings the user should be able to change go through `ctx.settings.define([{ key: "targetBranch", label: "Target branch", type: "string", default: "main", folder: true }])` (key becomes `<id>.targetBranch`) and `ctx.settings.get("targetBranch", task.folderId)`; the UI reads them with `useSetting(key, folderId)` and change them with `setSetting(key, value, folderId?)`. Use `kv` only for the plugin's own bookkeeping. Plugin data on folders and tasks goes in `meta[<plugin id>]`.

Core events: `folder.created|updated|deleted|restored`, `task.created|updated|deleted`, `process.answered` `{ taskId, process, node, question, answer, automatic }`, `task.archived|restored`, `task.status.changed` `{ task, from, to }`, `session.started|exited|removed`, `session.activity` `{ id, taskId, busy, asking, waiting }`, `agent.signal` `{ sessionId, taskId, name, text }`, `settings.changed` `{ key, folderId?, value }`, `process.updated` (a `ProcessRun`), `automation.run` `{ automationId, runId, taskId, result, detail }`, `automation.updated|deleted`, `archive.swept` `{ archived, deleted }`, `audit.alarm`, `app.stopping` (clear timers, stop processes you started).

## The archive

A task is not deleted at once: it goes to the archive (`task.archivedAt`, `archivedBy`: "user", "rule", "folder", "automation:<id>" or a plugin's id) and is deleted from there. `ctx.tasks.list()` gives the tasks in the tree; `list(folderId, { archived: true | "all" })` the archived ones; `ctx.tasks.get` any. `ctx.tasks.archive(id)` / `restore(id)` (permission `tasks:write`). An archived task is read only for the user; its agents are stopped (`exitReason: "archived"`) and its process stays where it was. Listen to `task.archived` to clean up what you started for a task (a stand, a lock). Deleting a folder archives its tasks; restoring one brings the folder back. Rules (settings `archiveAfter`, `archiveDeleteAfter`, `folder: true`, off by default) archive done tasks (`task.doneAt`) and delete archived ones (not `task.keep`); `src/server/archive.ts`.

## Automations

An automation (`src/server/automations.ts`, in the core) makes a task in its folder by a cron schedule or a webhook (`POST /hooks/<id>[/<secret>]`, checked by its own secret, not the login token) and starts its process, answering the first form from its `answers`. Later questions of the process it answers for the user by `questions` (`"<node path>:<question id>": { answer, when? }`: an option's id or "stop", only when a key a step wrote has a value); a question it has no answer for waits for the user, and one not in `seen` (asked since the user set it up) is shown as new on its page. The process core calls `processes.autoAnswer` for that. The task has `meta.automation = { id, runId, how, payload? }`. Plugins read them with `ctx.automations.list()` / `runs(id)` and hear `automation.run`.

What the main panel shows is the selection: `select({ kind: "task" | "folder", id })`, `{ kind: "settings" }`, `{ kind: "archive", folderId? }`, `{ kind: "archived", id }`, `{ kind: "automations" }`, `{ kind: "automation", id }` or a plugin's page `{ kind: "page", plugin, page, params }`, with `selectTask`, `selectFolder`, `openSettings`, `openArchive`, `openTask` (in the tree or the archive), `selectAutomation`, `openPage`, `useSelectedTask`, `useSelectedFolder` in `#sdk/ui`.

A plugin's own pages: `defineUiPlugin({ pages: { results: Page } })`, opened with `openPage("<id>", "results", params)`. Commands for the palette: `defineUiPlugin({ commands: [{ id, label, scope?, run }] })`; `allCommands()` lists them with the core's. `TaskTable` (`#sdk/ui`) is the table of tasks with picking and actions the archive and the folder's page use. `archiveTasks`, `restoreTasks`, `confirmDeleteForever`, `undoArchive` act on tasks like the menus do; they move the selection and the focus to the next row of the same section (`src/ui/tree.ts`); a plugin that removes tasks itself calls `const moveOn = leavingTree(ids)` before and `moveOn()` after; `getState().picked` are the tasks picked in the tree.

`plugins/<id>/ui.tsx`:

```tsx
import { Button, defineUiPlugin, rpc, toast, type Task } from "#sdk/ui";

function Ping({ task }: { task: Task }) {
  return <Button size="sm" onClick={async () => toast(await rpc<string>("<id>", "ping"))}>Ping</Button>;
}

export default defineUiPlugin({ slots: { "task.header": Ping } });
```

Slots (`src/ui/slots.tsx`): `header.actions`, `sidebar.header`, `sidebar.nav` (pages at the top, above the folders' header and before Automations: Processes), `sidebar.footer` (items under the tree, with the Archive), `tree.menu` (the menu of a right click on the tree's empty space; `openNewFolderDialog(parentId)` opens the New folder dialog), `process.bar` (actions on the step, in the task header before the process's answers), `process.question` (under the question a task's process waits on; render nothing when there is no hint), `folder.badge`, `folder.menu`, `folder.settings` (sections on the folder's page: wrap them in `<Section>`), `folder.create` (fields in the New folder dialog; `onCreate({ check, created })` in an effect says what they do on submit), `task.badge`, `task.menu` (also the task header's "…"), `task.header` (the header's right side), `task.panel` (under the header: only what must be seen now, a warning), `task.details.description`, `task.details.process`, `task.details.environment` (sections of the task's details panel: what can wait goes there; `openDetails(tab)` opens it), `session.toolbar`, `field.actions` (the corner of every `<TextArea>`, the multiline field; gets a `FieldHandle` with `insert(text)`). Menu slots render `<MenuItem>`s.

Keyboard shortcuts (`src/ui/shortcuts.ts`): `defineUiPlugin({ shortcuts: [{ keys: "Mod+K", scope: "task", run: (task) => ... }] })`. Scope `task` or `folder` acts on the tree row in focus (or the open task), `global` on nothing in particular; they are ignored in inputs and the terminal unless `inInputs: true`. `#sdk/ui` has `startRename`, `archiveTasks`, `confirmDeleteForever`, `confirmDeleteFolder` for them; see `plugins/hotkeys`. Give a shortcut a `command` and a menu item shows its keys with `<MenuItem shortcut={shortcutHint("rename", "task")}>`.

Use the kit from `#sdk/ui` (Button, IconButton, Menu*, Dialog, `prompt()`, `confirm()`, `showCustomDialog()` for a plugin's own dialog, `toast()`, Badge, StatusDot, EmptyState) and the Tailwind tokens (`bg-panel`, `bg-raised`, `border-line`, `text-muted`, `text-faint`, `bg-accent`, ...) instead of raw colors, so the plugin looks native in both themes. Strings go through `addStrings({ en, ru })` and `t()`. No emoji in the interface; icons come from `lucide-react`.

## Processes

What happens to a task is a process: a graph of steps that the core runs with LangGraph (`src/server/processes.ts`) and keeps in the database, so a process waiting for the user survives a restart. A task gets one process when it starts; it cannot switch. Steps and processes are separate on purpose: a step plugin offers reusable steps, a process plugin wires them.

```ts
// a step plugin: plugins/git-steps/server.ts
ctx.steps.register({
  id: "worktree",
  label: "Create a worktree",
  reads: ["github.issue?"],          // "namespace.name"; "?" = optional. Only these reach the step.
  writes: ["git.workspace", "git.branch"], // anything else it returns fails the step
  run: async ({ task, state, params, ask }) => ({ "git.workspace": dir, "git.branch": branch }),
});

// a process plugin: plugins/dev-flow/server.ts
ctx.processes.register({
  id: "dev",
  label: "Development",
  icon: "git-branch",                // lucide name, kebab case: the folder's button
  hotkey: "Alt+D",                   // optional; else Alt and the button's place
  nodes: { worktree: "git-steps.worktree", review: { step: "agent-steps.review", params: { ... } }, ship: "git-steps.ship" },
  edges: [
    ["start", "worktree"],
    ["worktree", "review"],
    ["review", (s) => (s["review.decision"] === "ship" ? "ship" : "worktree"), ["ship", "worktree"]],
    ["ship", "end"],
  ],
});
ctx.processes.start(task.id, "dev-flow.dev");
```

- **Processes as files.** A process with no code in it goes in `plugins/<id>/processes/<name>.json` (the same fields, `nodes` naming steps by full id, branches as `["test", { "on": "tests.passed", "cases": { "true": "manual" }, "else": "code" }]`); the core loads them after the plugins and when they change. This is what the process editor (`plugins/process-editor`) reads and writes; a code router (`[from, fn, targets]`) still works, but the editor only shows it. Each version of a file process is kept (`ctx.processes.versions(id)`): a task finishes on the version it started with. `ctx.processes.save(plugin, spec, note)` writes one; a spec with `overrides: "<plugin>.<id>"` is the user's own version that runs in its place.
- **Describe steps for the editor**: `icon`, `group` ("you", "agent", "git", "tests", ...), `role` ("you" / "agent" / "app"; "you" by default when it always asks), `labels` (words for its keys), `params` (its card's form; `default: { setting: "<key>" }` reads the folder's setting, and the step gets them in `params`), `outcomes` (`{ "tests.passed": { true: "passed", false: "failed" } }`: what a process can branch on), `questions` (what it asks, with `when` for one asked only sometimes; ask() with the same `id`), `sideEffects` (a trial without consequences skips it). Words in the user's language come from the plugin's `addStrings`: `step:<id>`, `outcome:<key>:<value>`, `question:<step>:<id>`, `option:<step>:<id>`, `field:<step>:<id>`, `param:<step>:<key>`, `key:<key>`, `process:<id>`.
- **The contract**: before a process runs, the core checks that every step exists and that every key a step reads, some step writes (or the process takes it in `inputs`), that every node is reached and can reach the end. `ctx.processes.list()` gives the problems, and `issues` with a code the UI words (`issueText` in `#sdk/ui`).
- **Steps in words**: `plugins/prompt-steps` registers each `plugins/my-processes/steps/*.md` as a step for an agent; `ctx.steps.remove(id)` takes back a plugin's own step, and `blocked: (params) => why` keeps a process with the step from running (the stand-in of a step being made). A step waiting for its agent asks with the question id "agent": `pitwall finished` (basic-steps) answers it.
- **The trace**: `ctx.processes.trace(taskId)` lists the steps a task's process ran, what each returned and what the user answered.
- **Task buttons.** A folder's setting `taskProcesses` (a list of `{ process, icon?, hotkey? }`, inherited by subfolders) puts a button per process where "New task" was, up to five, the rest in the folder's menu with "Other process…" and "Task without a process". A button makes the task with `POST /api/tasks { folderId, title, process }` (`processes.createTask`) and opens it. The process's icon and hotkey are defaults the folder can change; the hotkey acts on the folder in focus or the open task's folder. The new-folder dialog asks for the name, the agent and this list, starting from the last folder's choice (a subfolder: its parent's).
- **The creation screen is the first step's `ask()`** with a form; the step then names the task with `setTask({ title, body })`. A process without one starts working at once. The task is created first, named "New task".
- **`progress(text)`** tells the user what a working step is doing: the task's row shows a clock and the task's page the text. A new step starts without one.
- **`ask()`** stops the process and shows the user a choice (buttons) or a form (a field is text, or with `options` a pick of one or, with `multiple`, several, plus `other` for the user's own text; `suggestion` is a likely answer the user takes with Tab); `resume(taskId, answer)` continues it. The step then runs again from its start, so put side effects after `ask()` or make them repeatable.
- **Statuses come from the graph.** A node's `status` is the task's status while it runs; `doneStatus` (default `done`) is set at the end. While a process runs, nobody else changes the status: the task header offers the options of the waiting question as buttons (an option's `status` in its tooltip), and picking one answers it. So a process's manual transitions are its questions: `ask({ kind: "choice", options: [{ id: "back", label: "Back to development", status: "in_progress" }, ...] })`.
- The task page shows the process in its header: over the task's name the step running or the question (its words translated by `question:<step>:<id>`, `:body`, `:submit`), on the right the question's options as buttons or Retry with the error; a form goes under the header. A one-option question while the task's agent runs counts as waiting for the agent: its answer goes in the task's "…". The details panel (Alt+Shift+P) lists the steps the task ran. No UI code is needed in the process plugin.
- `step.task` is read fresh for each step: a body the user edited after the start reaches the next steps.
- A step that throws leaves the process `failed`; `POST /api/tasks/<id>/process/retry` runs it again. A step that was running when the app stopped is `failed` after the restart.

`plugins/dev-flow` is the development process: it shows steps that wait for an agent (`pitwall done`), a lock shared by tasks (`kv`) and a stand process.

`plugins/customize-app/process.ts` still builds its own LangGraph graph; it moves to steps when the development process exists.

Set `"enabled": false` in plugin.json to switch a plugin off without deleting it.
