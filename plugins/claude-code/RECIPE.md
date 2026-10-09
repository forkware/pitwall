# Claude Code

## Intent

Run Claude Code as an agent with the user's own subscription and login: the app starts the `claude` CLI in a terminal and never sees an API key.

## Spec

- Provider id `claude-code`, the default agent.
- A start with a prompt passes it as the first argument, which opens an interactive session with that message.
- When `claude` is not in PATH, starting it says so instead of failing silently.
- Claude's session id is the app's session id (`--session-id`). A session the app's restart suspended comes back with `claude --resume <id>` when its terminal is opened, if Claude has a transcript for it; with nothing said yet, it starts afresh with the same id.
- Out of its usage limit ("Usage limit reached · continuing automatically at …", "You've hit your session limit · resets …" at the end of the screen) Claude waits for the reset and goes on by itself: the provider's `waits(screen)` says so, and the session counts as working, so it is not asked whether it finished. A bare "resets 3pm" is not enough, Claude shows it near the limit too.

## Check

Start an agent in any task: Claude Code's interface appears in the terminal.
Say something to it, restart the app, open the task: the same conversation is there, ready for the next message.
`pnpm test plugins/claude-code` checks the arguments, the transcript lookup and the usage-limit screen.
At the limit, the task's agent is not asked "Are you finished?" until Claude goes on and falls quiet again.
