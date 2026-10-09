# Development process

## Intent

The user describes a task in their own words; the rest goes by itself until they have something to try.
An agent names the task, restates it and asks the user what is unclear, another works on it in its own git
worktree from `dev` until the tests pass. Then the app waits for manual testing: one button starts the dev
stand, so the user tries the work at once without thinking how to run it, and either sends it back with a
comment or lets it into `dev`. Only one task merges into `dev` at a time.

## Spec

```
                                                                         ┌ retry ┐
describe → refine → clarify → workspace → code → wait → test ─┬─ passed → manual ─ stand → stand ─┬─ ready → merge → test-dev → end (In dev)
                                           ▲                  │            │ (ready → merge)       │
                                           └──── failed ──────┴────────────┴── back + comment ─────┘   (and a conflict or failed dev tests)
```

- **describe**: the creation form, one field; the user's words become the task's body as they are.
- **refine**: the folder's agent without a terminal (`claude -p`, `codex exec`) returns `{ slug, title, spec, assumptions, questions }`.
  The task takes the title; the spec goes to `meta["dev-flow"].spec`, shown (as Markdown) in the Description tab of the
  task's details, above the user's own words (issue #51).
- **clarify**: the agent's questions (at most 5, `dev.questions`) as a form, one optional field each; the answered
  ones are added to the spec under "Clarifications". No questions: the step passes without asking. The questions
  come from refine, not from this step, because a step runs again from its start after the answer.
  Each question comes with the agent's most likely answer (same call, `{ question, options?, multiple?, answer }`):
  the field's `suggestion`, grey in the empty field with a Tab sign, or the suggested options outlined. Tab there
  takes it; typing or picking hides it; an untaken suggestion goes nowhere. The agent is asked for at most 250
  characters; a longer answer is not shown (never cut).
  A question with `options` (2-6) is a choice of one, or of several with `multiple`, always with "Other…" for the
  user's own text; picked ones reach the spec joined with commas. Arrows (and Home/End) move among the options,
  Space picks the one in focus; each question is one Tab stop.
  Only real forks are asked: the prompt says [] is the normal answer, and what the agent can decide itself goes to
  `assumptions`, added to the spec under "Assumptions" for the user to see and correct.
- **workspace**: if the folder's directory is in a git repository with a commit: `git worktree add -b <slug>`
  from the integration branch (setting, `dev`; missing → the step fails), in `<repo>-worktrees/<slug>`
  (a taken name gets `-2`), with the ignored files of "Copy into worktrees" (`.env*`) copied over. The task's
  `workspace` points there, so its agents start in it. Then its dependencies are installed if it has a
  `package.json` and a lockfile but no `node_modules` (a fresh worktree has none, `node_modules` being ignored):
  `pnpm install --frozen-lockfile --prefer-offline` (or yarn, npm ci). Installed, not linked from the main
  checkout: pnpm hard-links packages from its global store, so it takes seconds and no extra disk, while a link
  would share one `node_modules` between branches whose dependencies differ. A failed install does not stop the
  work: the task's page shows a warning with the output, "Fix" (starts a Customize the app task with the failure
  and what to check, as voice-input does for Whisper) and "Hide" (rpc `dismissInstall`). An install that passes
  later (before the tests or the stand) clears it. Without git the agent works in the folder and nothing is merged.
- **code** starts the agent with the spec and how to use `pitwall`, or sends the running agent what to fix.
- **wait**: until the agent runs `pitwall done`, or the user presses "The agent finished". An agent quiet for
  "Ask the quiet agent after" seconds (5) is asked once whether it finished; not while it shows a permission
  prompt (the task shows "The agent waits for you"), while the user types, or while it waits for its usage limit to
  reset (its provider's `waits`); the quiet counts from the end of that wait.
- **test**: "Test command" (`pnpm test`) in the worktree, after installing its dependencies if it has a
  `package.json` and a lockfile but no `node_modules` (a fresh worktree has none); a failure goes back to the same agent with the output.
  After "Test failures before asking" (3) failures in a row the user decides: back to the agent or go on.
- **manual**: "Разработка и автотестирование завершены. Ждём ручного тестирования" with the button
  "Стартовать dev сервер" (and Ready to deploy / Back to the agent, for deciding without a stand). Status Review.
- **stand**: "Dev stand command" (`pnpm run dev`) in the worktree with a free port in `PORT` (dependencies
  installed first, as for the tests), unless the task's stand runs already. For this app, `pnpm run dev` is
  `scripts/dev.ts`: the server on `PORT` with its own data in `.dev-data/`, printing the link with its token; then Ready to deploy / Back to the agent (then a comment, sent to the agent), and the stand
  stops. A stand that exits at once shows the end of its output and "Start again"; no command shows why.
  Restarted on the same port if the app restarts while the user decides. While it waits, the task's header has
  "Открыть стенд" next to the answers (slot `process.bar`); the question itself has no body on the page, its
  address being that button. The Environment tab of the task's details shows the stand (rpc `stand`): its link
  (the address the stand prints for its port, with a login token, else `http://localhost:<port>`), command, port
  and PID, or the end of its output once it stopped; and the worktree: branch, folder, "Copy the path" (issue #51).
  The comment form after "Back to the agent" asks with the id `comment`, as its `questions` declare.
- **merge**: takes the lock of the repository (`kv "lock:<repo>"`; a holder that failed or is gone lets it go),
  commits what the agent left, `merge --no-ff` into the integration branch where it is checked out (or in a new
  worktree for it), locally, no push. A conflict goes back to the agent. Waiting tasks are woken when it is free.
- **test-dev**: the tests on the integration branch. Failing: `reset --keep` back to before the merge, the task
  back to its agent. Passing: the task's agents running in the worktree are ended with the reason
  `dev-flow.merged` ("Merged into dev; the agent was stopped and its worktree removed"), the worktree is removed
  (setting), and the branch is deleted, its work being in the integration branch (issue #31: branches pile up
  otherwise); its last commit is kept in `meta["dev-flow"].commit`. The status is **In dev**.
- **Continuing such an agent** (the "Ended agents" card, `ctx.workspaces.registerRestorer`): the worktree comes
  back at the same path, so the agent's conversation is found: on its branch if it still exists, else on a new
  branch of the same name (or a free one, if another task took it) from the current integration branch, or from
  the kept commit when that branch is gone. Ignored files are copied again and the task's workspace points at it.
- The agent can at any time `pitwall rename "<title>"` and `pitwall spec "<markdown>"`.
- **An archived task** (issue #38) stops its stand and lets the integration branch go: a task waiting for it
  goes on; its worktree stays, so restoring the task finds its agent's conversation.

Statuses: Testing, Review, Merging, In dev.

## Check

- `pnpm vitest run plugins/dev-flow`: the whole road on a real temporary repository with a fake agent, the clarifying questions, the
  rollback after failing dev tests, the deleted branch and the worktree restored when the ended agent is continued, two tasks merging one after the other, no git, a missing branch, the nudge,
  a stand that does not start, dependencies installed with the worktree, an install that fails and leaves a warning.
- By hand: bind a folder to a repository with a `dev` branch, add "Development" to its task buttons, describe a
  task; an unclear one asks questions first; the task gets a name, a worktree next to the repository and an agent
  in it, with `node_modules` installed. When its tests pass the task shows "Ждём ручного тестирования"; "Поднять dev-стенд" brings up the
  stand, the header offers "Открыть стенд", the details' Environment tab shows its port and the worktree.
