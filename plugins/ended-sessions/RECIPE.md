# Ended agents

## Intent

Many tasks showed only "Exited with code 129" and a `claude --resume …` line, and the agent never came back
(issue #31). Opening such a task, the user should see at once what state it is in and continue it with one
button, even when the agent's worktree was removed after the merge.

Why it happened: only agents cut off by the app's restart (`suspended`) come back when opened. An agent that
ended (`exited`) stayed so; the only way on was "+ agent", which starts a new conversation. Code 129 is SIGHUP,
which is how the app ends an agent: the Stop button, and dev-flow before it removes a merged worktree.

## Spec

- Between the session's toolbar and its terminal, for an ended session, a band says why it ended:
  - `exitReason` "stopped" → "The agent was stopped"; "gone" → "The agent's directory was removed";
  - a plugin's own reason is a string key it adds itself (dev-flow: "Merged into dev; the agent was stopped and its worktree removed");
  - no reason: "The agent finished" (code 0) or "The agent exited with an error (code N)". The code is in the tooltip.
- Under it, what continuing does, and the buttons:
  - **Continue the conversation** (main): the same tab, the same conversation (`--resume`) when the provider finds it;
    "Start it again" when it cannot resume (a fresh conversation in the same directory);
  - the directory is gone and a plugin can restore it: its description (dev-flow: the worktree comes back where it
    was) and **Restore and continue**;
  - the directory is gone and nothing restores it, or the agent is not installed: no main button;
  - **New agent** (secondary, main when there is nothing to continue): a new tab whose agent starts with the
    task's title and description.
- Nothing is marked in the tree, and the terminal is not folded (the user's choice, for now).

The core parts: `Session.exitReason`; `ctx.agents.stop(id, reason)`; `ctx.agents.continuation(id)` and
`ctx.agents.continue(id)` (`Sessions.continue` in `src/server/sessions.ts`: restores a missing directory through
the first `ctx.workspaces.registerRestorer({ offer, restore })` that offers, then starts the agent like a resume);
the `session.ended` slot in `src/ui/slots.tsx`.

## Check

- `pnpm test` runs `tests/ended-sessions.test.ts`: what the card says for each reason and possibility, a stopped
  agent continued in its tab with its conversation, an agent that exited by itself, a removed directory that
  cannot be continued but gets a new agent with the task, and one a plugin restores. `plugins/dev-flow/tests`
  continues an agent after the merge and checks the worktree and branch it gets back.
- By hand: stop an agent with Stop: the band says it was stopped, "Continue the conversation" brings it back in
  the same tab where it was. In a dev-flow task merged into dev: "Restore and continue" makes the worktree again
  and the agent goes on.
