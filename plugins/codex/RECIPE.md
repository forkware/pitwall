# Codex

## Intent

Run OpenAI's Codex CLI as an agent with the user's own login (ChatGPT subscription or API key): the app starts `codex` in a terminal and never sees a key. Like Claude Code, a Codex session the app's restart cut off comes back in the same conversation.

## Spec

- Provider id `codex`. A start with a prompt passes it as the first argument.
- Codex cannot be told an id at start. It records each conversation in `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl` (`~/.codex` by default), whose first line, `session_meta`, has the id, the directory and when Codex began it, a few seconds after its start. Codex writes the file with the first message.
- So a session's conversation is the rollout in its directory begun closest after the session started (5 s before to 60 s after), not taken by another session, leaving out `codex exec` runs. The core asks each second while the agent runs and keeps the answer.
- A suspended session resumes with `codex resume <id>`; with no conversation yet, it starts afresh.

## Check

Install Codex (`npm i -g @openai/codex`) and log in (`codex login`). Start Codex in a task, say something, restart the app, open the task: the conversation is there.
`pnpm test plugins/codex` checks the lookup on fake rollouts.
