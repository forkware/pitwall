# Basic steps

## Intent

People build their own processes from steps (issue #40), and not every process is software development: "research → draft → my edit", "sort what comes in". These are the steps anyone can build with, each described for the process editor, and three templates to start from.

## Spec

- **Describe the task** (you): a form for the task's title and description, which name the task; the question and whether to ask for a description are its settings.
- **Ask me** (you): a question with buttons from its card, one answer per line; `Done → done` also moves the task to that status. It writes `choice.answer`, so the process can go a different way for each answer.
- **Task for the agent** (agent): gives the folder's agent a task in the task's terminal (`{{task.title}}`, `{{task.body}}`, `{{agent.answer}}` and the other keys below fill in) and waits until the agent runs `pitwall finished`, or the user presses "The agent finished". Coming back to it gives the task again; the answer to its own question does not.
- **An agent answers** (agent): an agent answers without a terminal (`agents.run` with the terminal fallback) in the task's directory; with answers to pick from it decides, and the process branches on `agent.choice`. It writes `agent.answer` too.
- **Run a command**: in the task's directory; writes `command.passed` (a branch: passed / failed) and `command.output`.
- **Name it after the time**: a note.
- **Templates** (`template: true`): Agent and my check, Research → draft → my edit, Sort what comes in (for automations). Words in Russian for the steps, their settings, and what a template's copy starts with (`tvalue`, `tparam`, `tlabel`, `tdefault`).

## Check

`pnpm test` runs `tests/basic-steps.test.ts`: answers one per line with a status, prompts filled in, the templates can run, "Ask me" branches on its answers and moves the status, "Task for the agent" gives its task once and goes on when the agent says `pitwall finished`. By hand: Processes → New → "Agent and my check"; or build one from "Ask me" and "Run a command" and try it without consequences.
