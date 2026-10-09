# Example processes

## Intent

Processes to try a folder's task buttons with (issue #10), and a short example of how a process plugin is written: a creation form, an agent, a question that moves the status, and a process with no questions at all. Simple task (a form, a Think step with progress, "Is it done?") was removed in issue #32: it was only a demo; the core's `progress()` is covered by `test/processes.test.ts`.

## Spec

- **Agent task** (`bot`): the first step asks for a title and a description in a form under the task's header; that is the task's creation screen, and it names the task (trimmed). Then it starts the folder's default agent with the title and description as its prompt (status In progress), then asks only "Is it done?" with Done (status done).
- **Quick note** (`notebook-pen`, `Alt+N`): no form; the task is named "Note <date time>" at once and stays To do.

The core part: `ProcessDef.icon` and `hotkey`; `StepContext.setTask()` and `progress()`; `ProcessRun.progress`; the folder setting `taskProcesses`; `POST /api/tasks` with `process`.

## Check

`pnpm test` runs `tests/example-flow.test.ts`. By hand: create a folder; the dialog offers Agent task and Quick note, and no Simple task; hover the folder and press the bot icon: the task opens with the form; fill it in; the agent starts with it; answer Done. Press Alt+N with the folder in focus: a note appears.
