# Search

## Intent

Find any task, including the archived ones, without scrolling the tree (issue #38): "Ctrl+K and type a word" to jump to a task, folder or command, and a page with all results and filters to sort through many. The archive stays out of the way until asked for.

## Spec

- **Where.** A "Search… Ctrl+K" field above the folder tree. `Ctrl/Cmd+K` (outside fields and terminals, where Ctrl+K is the shell's) opens the palette; `Ctrl/Cmd+Shift+F` opens the results page.
- **The palette.** With nothing typed, the last opened tasks. Typing: tasks (best first; archived ones last, marked "in the archive", and they open read only), folders whose name matches, commands of the core and of plugins (`defineUiPlugin({ commands })`; a task or folder command only when one is open), and "All results" (`Ctrl+Enter`) that opens the page. Arrows move, Enter opens.
- **What it searches.** The title (weighed most), the description, every string in the task's plugin data (dev-flow's spec, an issue number, a webhook's payload), the folder's path. Words match by their start ("голос" finds "голосовой"), all words must match. What the agents printed only with "Search the agents' conversations" on the page (the last 200 KB of each session).
- **Prefixes** in the palette and the page: `in:<folder>` (with subfolders), `status:<id>`, `is:archived|waiting|asking|failed|working|open|done`, `from:schedule|cron|webhook|manual`, `flow:<process>`, `created:7d`, `updated:30d`.
- **The page.** The query and filters: folder, status, process, source (by hand, schedule, webhook, an automation), state (waits for an answer, the agent asks, process failed, the agent works), changed within days, the archive (without, with, only), the conversations. Results in the core's task table, with the matching text under the title; archived results in a table of their own, with Restore and Delete forever. With nothing found but something in the archive: "Nothing found here. In the archive: N · Show".

The core parts: `ctx.tasks.list(folderId, { archived })`, `ctx.agents.log(sessionId)`, `ctx.automations.list()`; in the UI `defineUiPlugin({ pages, commands })`, `openPage`, `allCommands`, `openTask`, `TaskTable`.

The index is SQLite FTS5 in memory, built at start and kept up to date from task and folder events.

## Check

`pnpm test` runs `tests/search.test.ts`: words by their start in each field with a snippet, the archive left out and counted, the filters and prefixes, the index following renames and deletions, the agents' output only when asked. By hand: press Ctrl+K, type part of a task's name, Enter; type a word of an archived task and see it last; Ctrl+Enter for the page and try the filters.
