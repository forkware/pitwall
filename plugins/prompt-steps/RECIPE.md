# Steps in words

## Intent

A step that a process needs and no plugin has is usually a task for an agent: "write a changelog", "check the texts are translated" (issue #40). The user makes it in words, without code; it is a step like any other in the process editor.

## Spec

- **A step is a Markdown file** in `plugins/my-processes/steps/<name>.md`: settings on top (`label`, `description`, `mode: answer | terminal`, `key`, `options: a, b`), the task for the agent below, with `{{task.title}}`, `{{task.body}}` and `{{<key>}}` of other steps inserted. It registers as `prompt-steps.<name>`; changed and new files load at once, a deleted one goes.
- **mode: answer**: an agent answers once in the task's directory (`agents.run`, in a terminal nobody sees when it has no `exec`); it writes `<key>.text`, and with `options` `<key>.choice`, which the process can branch on.
- **mode: terminal**: the folder's agent gets the task in the task's terminal and the step waits until it runs `pitwall finished` (basic-steps answers any step that waits with the question id "agent") or the user presses the button.
- **The stand-in** `prompt-steps.pending` holds the place of a step an agent is making in code ("Ask an agent to make the step"): the process says it cannot run while it is there, and its card opens the task and puts the ready step in its place.
- RPC for the editor: `list`, `save` (a free name from the label), `remove`, `try` (the answer to a prompt on a task, the task's process untouched).

## Check

`pnpm test` runs `tests/prompt-steps.test.ts`: a file read and written back, the keys a prompt inserts, an agent's pick; a step made in words that an agent answers, the process branching on its pick; a deleted file takes its step back; the stand-in keeps the process from running. By hand: Processes → Steps → "New step in words", "Write a changelog", quickly with one answer, Try it on a task, Make the step; it is in the step picker.
