// The development process: the user's words → a named task in its own worktree → an agent until the tests
// pass → the user starts a dev stand and tries the work → merged into dev, one task at a time.
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { definePlugin, type FlowState, type StepContext, type Task } from "#sdk/server";
import {
  addWorktree,
  branchExists,
  checkoutOf,
  commitAll,
  copyIgnored,
  defaultWorktrees,
  deleteBranch,
  freeSlug,
  git,
  inRepo,
  isAncestor,
  isDirty,
  merge,
  removeWorktree,
  repoRoot,
  restoreWorktree,
  tryGit,
  undoMerge,
} from "./git.ts";
import {
  codePrompt,
  devTestsFailed,
  installFailed,
  mergeConflict,
  nudge,
  parseRefined,
  refinePrompt,
  testsFailed,
  toQuestion,
  type Question,
  userComment,
  withAnswers,
} from "./prompts.ts";
import { installCommand, runCommand, standLink, Stands, tail } from "./shell.ts";

/** What the process keeps on the task, in meta["dev-flow"]. */
export interface DevMeta {
  /** The agent's restatement of the request: the description it works from. */
  spec?: string;
  repo?: string;
  worktree?: string;
  branch?: string;
  /** The folder's place inside the repository, the same in the worktree. */
  sub?: string;
  standPort?: number;
  standDir?: string;
  /** The branch's last commit when its worktree was removed after the merge. */
  commit?: string;
  /** The branch was deleted then, its work being in the integration branch. */
  branchDeleted?: boolean;
  /** The last install of the worktree's dependencies failed: shown as a warning with a button to fix it. */
  installFailed?: { dir: string; output: string; request: string } | null;
}

const PROCESS = "dev-flow.dev";
/** Whether `dir` is `root` or inside it. */
const inside = (root: string, dir: string) => !relative(root, dir).startsWith("..") && !isAbsolute(relative(root, dir));
/** The nodes during which a task holds the integration branch. */
const HOLDING = ["merge", "test-dev"];

export default definePlugin((ctx) => {
  const stands = new Stands();
  /** The app is shutting down: nothing scheduled may touch the core any more. */
  let stopped = false;
  process.on("exit", () => stands.stopAll());

  ctx.statuses.register([
    { id: "testing", label: "Testing", color: "violet", category: "active" },
    { id: "review", label: "Review", color: "amber", category: "active" },
    { id: "merging", label: "Merging", color: "blue", category: "active" },
    { id: "in_dev", label: "In dev", color: "green", category: "done" },
  ]);

  ctx.settings.define([
    {
      key: "integrationBranch",
      label: "Integration branch",
      description: "Worktrees start from it and finished tasks are merged into it. It must exist.",
      type: "string",
      default: "dev",
      folder: true,
    },
    {
      key: "worktreesDir",
      label: "Worktrees directory",
      description: "Where task worktrees go; empty: next to the repository, in <repo>-worktrees.",
      type: "string",
      default: "",
      folder: true,
    },
    {
      key: "copyFiles",
      label: "Copy into worktrees",
      description: "Files git does not carry over (ignored ones), as patterns relative to the repository.",
      type: "json",
      default: [".env*"],
      folder: true,
      validate: (v) => (Array.isArray(v) && v.every((p) => typeof p === "string") ? undefined : "expected a list of patterns"),
    },
    { key: "testCommand", label: "Test command", description: "Empty: no tests.", type: "string", default: "pnpm test", folder: true },
    {
      key: "standCommand",
      label: "Dev stand command",
      description: "Runs in the worktree while you try the work; it gets a free port in PORT. Empty: no stand.",
      type: "string",
      default: "pnpm run dev",
      folder: true,
    },
    {
      key: "maxTestFailures",
      label: "Test failures before asking",
      description: "After this many failed runs in a row the process asks you what to do.",
      type: "number",
      default: 3,
      folder: true,
    },
    {
      key: "idleSeconds",
      label: "Ask the quiet agent after, s",
      description: "An agent quiet this long is asked whether it is finished; not while it asks you or you type.",
      type: "number",
      default: 5,
      folder: true,
    },
    {
      key: "removeWorktree",
      label: "Remove the worktree after merging",
      type: "boolean",
      default: true,
      folder: true,
    },
  ]);

  const setting = <T,>(key: string, task: Task) => ctx.settings.get<T>(key, task.folderId);
  const own = (taskId: string): DevMeta => (ctx.tasks.get(taskId)?.meta[ctx.id] as DevMeta | undefined) ?? {};
  const saveMeta = (taskId: string, patch: Partial<DevMeta>) =>
    ctx.tasks.update(taskId, { meta: { [ctx.id]: { ...own(taskId), ...patch } } });
  const runningSession = (taskId: string) => ctx.agents.sessions(taskId).filter((s) => s.state === "running").at(-1);
  /** Where the task's work is: its worktree, else the directory its agent ran in. */
  const workDir = (task: Task, state: FlowState) =>
    (state["dev.workspace"] as string | null) ?? ctx.workspaces.ofFolder(task.id) ?? ctx.agents.sessions(task.id).at(-1)?.cwd;

  /**
   * Installs the worktree's dependencies if it has none; the failed install's output, if it fails. The task
   * keeps the failure (or forgets it once an install passes) for the warning on its page.
   */
  const install = async (taskId: string, cwd: string, progress: (text: string) => void): Promise<string | undefined> => {
    const command = installCommand(cwd);
    if (!command) return undefined;
    progress(`Running ${command}`);
    const { code, output } = await runCommand(command, cwd);
    const failed = code === 0 ? undefined : `$ ${command}\n${tail(output)}`;
    if (failed || own(taskId).installFailed) {
      saveMeta(taskId, { installFailed: failed ? { dir: cwd, output: failed, request: installFailed(cwd, failed) } : null });
    }
    return failed;
  };

  // The integration branch, one task at a time: kv "lock:<repo>" holds the task merging into it.

  const holds = (taskId: string) => {
    const run = ctx.processes.run(taskId);
    return run?.process === PROCESS && (run.state === "running" || run.state === "waiting") && HOLDING.includes(run.node ?? "");
  };
  /** Takes the lock, or returns the task that has it. A holder that failed or is gone has let it go. */
  const acquire = (repo: string, taskId: string): string | undefined => {
    const holder = ctx.kv.get<string | null>(`lock:${repo}`);
    // An archived holder has let it go too: its process waits, but nobody will finish it there.
    if (holder && holder !== taskId && ctx.tasks.get(holder) && !ctx.tasks.get(holder)!.archivedAt && holds(holder)) return holder;
    ctx.kv.set(`lock:${repo}`, taskId);
    return undefined;
  };
  const release = (repo: string, taskId: string) => {
    if (ctx.kv.get(`lock:${repo}`) === taskId) ctx.kv.set(`lock:${repo}`, null);
    wakeWaiting();
  };
  /** Tasks waiting for the branch try again; the first one gets it. */
  const wakeWaiting = () =>
    setImmediate(() => {
      if (stopped) return;
      for (const task of ctx.tasks.list()) {
        const run = ctx.processes.run(task.id);
        if (run?.process !== PROCESS || run.state !== "waiting" || run.node !== "merge") continue;
        try {
          ctx.processes.resume(task.id, "check");
        } catch {}
      }
    });
  ctx.events.on("task.deleted", wakeWaiting);
  ctx.events.on("process.updated", (run) => {
    if (run?.process === PROCESS && run.state === "failed") wakeWaiting();
  });

  // Steps

  ctx.steps.register({
    id: "describe",
    label: "Describe the task",
    icon: "pencil-line",
    group: "you",
    questions: [{ id: "main", kind: "form", title: "What should be done?", fields: [{ id: "prompt", label: "In your own words", required: true }] }],
    run: ({ ask, setTask }) => {
      const { prompt } = ask<{ prompt: string }>({
        kind: "form",
        title: "What should be done?",
        fields: [
          {
            id: "prompt",
            label: "In your own words",
            multiline: true,
            required: true,
            placeholder: "What to change, why, and how you will check it",
          },
        ],
        submit: "Start",
      });
      setTask({ body: prompt.trim() });
    },
  });

  ctx.steps.register({
    id: "refine",
    label: "Name the task",
    description: "An agent without a terminal names the task and restates the request as its description.",
    icon: "sparkles",
    group: "agent",
    role: "agent",
    writes: ["dev.slug", "dev.questions"],
    labels: { "dev.slug": "the branch name", "dev.questions": "the agent's questions" },
    run: async ({ task, progress, setTask }) => {
      progress("The agent names the task");
      const answer = await ctx.agents.run(refinePrompt(task.body), {
        folderId: task.folderId,
        cwd: ctx.workspaces.ofFolder(task.id),
      });
      const refined = parseRefined(answer, task.body);
      setTask({ title: refined.title });
      saveMeta(task.id, { spec: refined.spec });
      return { "dev.slug": refined.slug, "dev.questions": refined.questions };
    },
  });

  ctx.steps.register({
    id: "clarify",
    label: "Clarify the task",
    description: "Asks the user the naming agent's questions and adds the answers to the description.",
    icon: "message-circle-question",
    group: "you",
    questions: [{ id: "main", kind: "form", title: "Questions before the work starts", when: "when the agent has questions" }],
    reads: ["dev.questions?"],
    run: ({ task, state, ask }) => {
      // A process that waited across an update may still hold plain strings.
      const questions = ((state["dev.questions"] as unknown[] | undefined) ?? []).map(toQuestion).filter((q): q is Question => !!q);
      if (!questions.length) return;
      const answers = ask<Record<string, string | string[]>>({
        kind: "form",
        title: "Questions before the work starts",
        body: "The answers go into the task's description. Tab takes the suggested answer; leave a field empty to let the agent decide.",
        fields: questions.map((q, i) =>
          q.options
            ? { id: `q${i}`, label: q.question, options: q.options, multiple: q.multiple, other: true, suggestion: q.suggestion }
            : { id: `q${i}`, label: q.question, multiline: true, suggestion: q.suggestion },
        ),
        submit: "Continue",
      });
      const spec = own(task.id).spec ?? task.body;
      saveMeta(task.id, { spec: withAnswers(spec, questions, answers ?? {}) });
    },
  });

  ctx.steps.register({
    id: "workspace",
    label: "Create the worktree",
    description: "A git worktree on a new branch from the integration branch, when the folder is in a repository.",
    icon: "git-branch-plus",
    group: "git",
    reads: ["dev.slug"],
    writes: ["dev.slug", "dev.repo", "dev.workspace"],
    labels: { "dev.repo": "the repository", "dev.workspace": "the task's worktree" },
    run: async ({ task, state, progress }) => {
      const folderDir = ctx.workspaces.ofFolder(task.id);
      const repo = folderDir ? repoRoot(folderDir) : undefined;
      if (!folderDir || !repo) return { "dev.repo": null, "dev.workspace": null };
      const meta = own(task.id);
      // Retried after the worktree was made: keep it.
      if (meta.worktree && existsSync(meta.worktree) && meta.branch) {
        const dir = join(meta.worktree, meta.sub ?? "");
        await install(task.id, dir, progress);
        return { "dev.slug": meta.branch, "dev.repo": repo, "dev.workspace": dir };
      }
      const base = setting<string>("integrationBranch", task);
      if (!branchExists(repo, base)) {
        throw new Error(`No branch ${base} in ${repo}: create it, or change "Integration branch" in the folder's settings`);
      }
      const configured = setting<string>("worktreesDir", task)?.trim();
      const root = configured ? (isAbsolute(configured) ? configured : join(repo, configured)) : defaultWorktrees(repo);
      const slug = freeSlug(repo, root, state["dev.slug"] as string);
      const worktree = join(root, slug);
      progress(`Creating ${worktree}`);
      addWorktree(repo, worktree, slug, base);
      copyIgnored(repo, worktree, setting<string[]>("copyFiles", task) ?? []);
      const sub = inRepo(repo, folderDir);
      const dir = join(worktree, sub);
      saveMeta(task.id, { repo, worktree, branch: slug, sub });
      ctx.tasks.update(task.id, { workspace: dir });
      // So the agent can build and test at once. A failure does not stop the work: the task shows a warning.
      await install(task.id, dir, progress);
      return { "dev.slug": slug, "dev.repo": repo, "dev.workspace": dir };
    },
  });

  ctx.steps.register({
    id: "code",
    label: "Hand it to the agent",
    description: "Starts the agent with the description, or sends the running one what to fix.",
    icon: "bot",
    group: "agent",
    role: "agent",
    reads: ["dev.feedback?", "dev.repo?"],
    writes: ["dev.feedback"],
    labels: { "dev.feedback": "what to fix" },
    run: ({ task, state }) => {
      const feedback = state["dev.feedback"] as string | null | undefined;
      const session = runningSession(task.id);
      if (session) {
        if (feedback) ctx.agents.send(session.id, feedback);
      } else {
        const meta = own(task.id);
        const prompt = codePrompt(meta.spec ?? task.body, {
          branch: state["dev.repo"] ? meta.branch : undefined,
          base: setting<string>("integrationBranch", task),
        });
        ctx.agents.start(task.id, { prompt: feedback ? `${prompt}\n\n${feedback}` : prompt });
      }
      return { "dev.feedback": null };
    },
  });

  ctx.steps.register({
    id: "wait",
    label: "The agent works",
    description: "Waits for the agent's `pitwall done`, or for the user to say it finished.",
    icon: "hourglass",
    group: "agent",
    role: "agent",
    questions: [
      {
        id: "main",
        kind: "choice",
        title: "The agent is working",
        options: [{ id: "done", label: "The agent finished" }],
        when: "when the agent does not say it is done",
      },
    ],
    run: ({ ask }) => {
      ask({
        kind: "choice",
        title: "The agent is working",
        body: "It runs `pitwall done` when it finishes; if it does not, press the button.",
        options: [{ id: "done", label: "The agent finished" }],
      });
    },
  });

  ctx.steps.register({
    id: "test",
    label: "Run the tests",
    icon: "flask-conical",
    group: "tests",
    reads: ["dev.workspace?", "dev.failures?"],
    writes: ["dev.passed", "dev.failures", "dev.feedback"],
    outcomes: { "dev.passed": { true: "passed", false: "failed" } },
    params: {
      command: {
        type: "string",
        label: "Test command",
        description: "Empty: no tests.",
        placeholder: "pnpm test",
        default: { setting: "dev-flow.testCommand" },
      },
    },
    questions: [
      {
        id: "main",
        kind: "choice",
        title: "The tests failed several times in a row",
        options: [
          { id: "agent", label: "Back to the agent" },
          { id: "skip", label: "Go on without them" },
        ],
        when: 'after "Test failures before asking" failed runs in a row',
      },
    ],
    run: async ({ task, state, ask, progress, params }) => {
      const command = (params.command as string | undefined)?.trim();
      const cwd = workDir(task, state);
      if (!command || !cwd) return { "dev.passed": true, "dev.failures": 0, "dev.feedback": null };
      const failedInstall = await install(task.id, cwd, progress);
      progress(`Running ${command}`);
      const { code, output } = failedInstall ? { code: 1, output: failedInstall } : await runCommand(command, cwd);
      if (code === 0) return { "dev.passed": true, "dev.failures": 0, "dev.feedback": null };
      const failures = ((state["dev.failures"] as number | undefined) ?? 0) + 1;
      const feedback = testsFailed(command, tail(output));
      if (failures >= (setting<number>("maxTestFailures", task) ?? 3)) {
        const answer = ask<string>({
          kind: "choice",
          title: `The tests failed ${failures} times in a row`,
          body: tail(output, 15),
          options: [
            { id: "agent", label: "Back to the agent", primary: true },
            { id: "skip", label: "Go on without them" },
          ],
        });
        if (answer === "skip") return { "dev.passed": true, "dev.failures": 0, "dev.feedback": null };
        return { "dev.passed": false, "dev.failures": 0, "dev.feedback": feedback };
      }
      return { "dev.passed": false, "dev.failures": failures, "dev.feedback": feedback };
    },
  });

  /** The user's verdict on the work: into dev, or back to the agent with a comment. Stops the stand either way. */
  const verdict = (task: Task, decision: string, ask: StepContext["ask"]): FlowState => {
    if (decision === "back") {
      const { comment } = ask<{ comment: string }>({
        kind: "form",
        // The id its `questions` declare: an automation's answer and the user's language find it by that.
        id: "comment",
        title: "What should the agent change?",
        fields: [{ id: "comment", label: "Comment", multiline: true, required: true }],
        submit: "Send to the agent",
      });
      stands.stop(task.id);
      return { "dev.decision": "back", "dev.feedback": userComment(comment.trim()), "dev.failures": 0 };
    }
    stands.stop(task.id);
    return { "dev.decision": "ready", "dev.feedback": null };
  };
  const READY = { id: "ready", label: "Ready to deploy", status: "merging" };
  const BACK = { id: "back", label: "Back to the agent", status: "in_progress" };

  ctx.steps.register({
    id: "manual",
    label: "Wait for manual testing",
    description: "The work passed its tests; the user starts the dev stand to try it, or decides without one.",
    icon: "user-round-check",
    group: "you",
    writes: ["dev.decision", "dev.feedback", "dev.failures"],
    outcomes: { "dev.decision": { stand: "Start the dev server", ready: "Ready to deploy", back: "Back to the agent" } },
    questions: [
      {
        id: "main",
        kind: "choice",
        title: "Development and automated tests are done. Waiting for manual testing",
        options: [{ id: "stand", label: "Start the dev server" }, READY, BACK],
      },
      { id: "comment", kind: "form", title: "What should the agent change?", fields: [{ id: "comment", label: "Comment", required: true }], when: "when you send it back" },
    ],
    run: ({ task, ask }) => {
      const decision = ask<string>({
        kind: "choice",
        title: "Разработка и автотестирование завершены. Ждём ручного тестирования",
        options: [{ id: "stand", label: "Стартовать dev сервер", primary: true }, READY, BACK],
      });
      if (decision === "stand") return { "dev.decision": "stand" };
      return verdict(task, decision, ask);
    },
  });

  ctx.steps.register({
    id: "stand",
    label: "Start the dev server",
    description: "Starts the dev stand in the worktree (or keeps the running one); the user tries the work on it.",
    icon: "server",
    group: "tests",
    reads: ["dev.workspace?"],
    writes: ["dev.decision", "dev.feedback", "dev.failures"],
    outcomes: { "dev.decision": { retry: "Start again", ready: "Ready to deploy", back: "Back to the agent" } },
    params: {
      command: {
        type: "string",
        label: "Dev stand command",
        description: "Runs in the worktree; it gets a free port in PORT. Empty: no stand.",
        placeholder: "pnpm run dev",
        default: { setting: "dev-flow.standCommand" },
      },
    },
    questions: [
      { id: "main", kind: "choice", title: "Try the work on the dev stand", options: [READY, BACK] },
      {
        id: "failed",
        kind: "choice",
        title: "The dev stand did not start",
        options: [{ id: "retry", label: "Start again" }, READY, BACK],
        when: "when the stand does not start",
      },
      { id: "comment", kind: "form", title: "What should the agent change?", fields: [{ id: "comment", label: "Comment", required: true }], when: "when you send it back" },
    ],
    run: async ({ task, state, ask, progress, params }) => {
      const command = (params.command as string | undefined)?.trim();
      const cwd = workDir(task, state);
      let stand: { exited: boolean; output: string; port: number } | undefined;
      if (command && cwd) {
        const failedInstall = await install(task.id, cwd, progress);
        if (failedInstall) stand = { exited: true, output: failedInstall, port: 0 };
        else {
          progress(`Starting ${command}`);
          // Running already (a replay after the user's answer): the same one.
          stand = await stands.start(task.id, command, cwd, own(task.id).standPort);
          saveMeta(task.id, { standPort: stand.port, standDir: cwd });
        }
      }
      const failed = stand?.exited ?? false;
      const decision = ask<string>({
        kind: "choice",
        // The editor's words for "main" do not fit the stand that failed or is not there: they have their own ids.
        id: !stand ? "none" : failed ? "failed" : "main",
        title: !stand ? "No dev stand" : failed ? "The dev stand did not start" : "Try the work on the dev stand",
        body: !stand
          ? 'Its command is empty ("Dev stand command" in the folder\'s settings), or the task has no directory.'
          : failed
            ? tail(stand.output, 15)
            : standLink(stand.output, stand.port),
        options: failed ? [{ id: "retry", label: "Start again", primary: true }, READY, BACK] : [{ ...READY, primary: true }, BACK],
      });
      if (decision === "retry") return { "dev.decision": "retry" };
      return verdict(task, decision, ask);
    },
  });

  // The user installed the dependencies by hand, or does not need them: the warning goes.
  ctx.rpc.handle("dismissInstall", ({ taskId }: { taskId: string }) => {
    if (own(taskId).installFailed) saveMeta(taskId, { installFailed: null });
  });

  // Where the stand runs, for the task's page while the user tries the work.
  ctx.rpc.handle("stand", ({ taskId }: { taskId: string }) => {
    const task = ctx.tasks.get(taskId);
    const stand = stands.get(taskId);
    if (!task || !stand) return null;
    const meta = own(taskId);
    return {
      url: standLink(stand.output, stand.port),
      port: stand.port,
      dir: meta.standDir ?? null,
      branch: meta.branch ?? null,
      command: setting<string>("standCommand", task)?.trim() ?? null,
      pid: stand.exited ? null : (stand.child.pid ?? null),
      running: !stand.exited,
      output: tail(stand.output, 15),
    };
  });

  ctx.steps.register({
    id: "merge",
    label: "Merge",
    description: "Waits until no other task merges into the integration branch, then merges the task's branch into it.",
    icon: "git-merge",
    group: "git",
    sideEffects: true,
    reads: ["dev.repo?", "dev.slug?"],
    writes: ["dev.merged", "dev.mergeResult", "dev.feedback", "dev.devDir", "dev.mergeBase", "dev.mergeCommit"],
    outcomes: { "dev.mergeResult": { merged: "merged", conflict: "a conflict", none: "nothing to merge" } },
    questions: [
      { id: "main", kind: "choice", title: "Waiting for the integration branch", options: [{ id: "check", label: "Check again" }], when: "while another task merges" },
    ],
    run: ({ task, state, ask, progress }) => {
      const repo = state["dev.repo"] as string | null | undefined;
      const meta = own(task.id);
      if (!repo || !meta.branch || !meta.worktree) return { "dev.merged": false, "dev.mergeResult": "none", "dev.feedback": null };
      const base = setting<string>("integrationBranch", task);
      for (let holder = acquire(repo, task.id); holder; holder = acquire(repo, task.id)) {
        ask({
          kind: "choice",
          title: `Waiting for ${base}`,
          body: `"${ctx.tasks.get(holder)?.title ?? holder}" is merging into ${base}; this task goes next.`,
          options: [{ id: "check", label: "Check again" }],
        });
      }
      try {
        progress(`Merging ${meta.branch} into ${base}`);
        if (existsSync(meta.worktree)) commitAll(meta.worktree, task.title);
        let devDir = checkoutOf(repo, base);
        if (!devDir) {
          const configured = setting<string>("worktreesDir", task)?.trim();
          const root = configured ? (isAbsolute(configured) ? configured : join(repo, configured)) : defaultWorktrees(repo);
          devDir = join(root, base);
          git(repo, "worktree", "add", devDir, base);
        }
        if (isDirty(devDir)) throw new Error(`${base} has uncommitted changes in ${devDir}: commit or stash them, then retry`);
        const result = merge(devDir, meta.branch, `Merge ${meta.branch}: ${task.title}`);
        if (!result.ok) {
          release(repo, task.id);
          return { "dev.merged": false, "dev.mergeResult": "conflict", "dev.feedback": mergeConflict(base, result.conflict) };
        }
        return {
          "dev.merged": true,
          "dev.mergeResult": "merged",
          "dev.devDir": devDir,
          "dev.mergeBase": result.base,
          "dev.mergeCommit": result.commit,
        };
      } catch (error) {
        release(repo, task.id);
        throw error;
      }
    },
  });

  ctx.steps.register({
    id: "test-dev",
    label: "Run the tests on the integration branch",
    description: "Tests the merge; when they fail, takes the merge back and returns the task to its agent.",
    icon: "flask-conical",
    group: "tests",
    sideEffects: true,
    reads: ["dev.repo", "dev.devDir", "dev.mergeBase", "dev.mergeCommit"],
    writes: ["dev.devPassed", "dev.feedback"],
    outcomes: { "dev.devPassed": { true: "passed", false: "failed" } },
    params: {
      command: {
        type: "string",
        label: "Test command",
        description: "Empty: no tests.",
        placeholder: "pnpm test",
        default: { setting: "dev-flow.testCommand" },
      },
    },
    run: async ({ task, state, progress, params }) => {
      const repo = state["dev.repo"] as string;
      const devDir = state["dev.devDir"] as string;
      const meta = own(task.id);
      const base = setting<string>("integrationBranch", task);
      try {
        const command = (params.command as string | undefined)?.trim();
        if (command) {
          progress(`Running ${command} on ${base}`);
          const { code, output } = await runCommand(command, join(devDir, meta.sub ?? ""));
          if (code !== 0) {
            undoMerge(devDir, state["dev.mergeBase"] as string, state["dev.mergeCommit"] as string);
            return { "dev.devPassed": false, "dev.feedback": devTestsFailed(base, command, tail(output)) };
          }
        }
      } finally {
        release(repo, task.id);
      }
      if (setting<boolean>("removeWorktree", task) && meta.worktree) {
        // Its agents are done: left running in a removed directory, they could not be continued after a restart.
        for (const session of ctx.agents.sessions(task.id)) {
          if (session.state === "running" && inside(meta.worktree, session.cwd)) ctx.agents.stop(session.id, "dev-flow.merged");
        }
        const commit = meta.branch ? tryGit(repo, "rev-parse", `refs/heads/${meta.branch}`) : undefined;
        removeWorktree(repo, meta.worktree);
        // Its work is in the integration branch now, so the branch is not needed to keep it; continuing the
        // task's agent makes it again (the restorer below).
        const branchDeleted = !!commit?.ok && isAncestor(repo, commit.out, base) && deleteBranch(repo, meta.branch!);
        saveMeta(task.id, { ...(commit?.ok ? { commit: commit.out } : {}), branchDeleted });
        ctx.tasks.update(task.id, { workspace: null });
      }
      return { "dev.devPassed": true, "dev.feedback": null };
    },
  });

  // The process itself is data: processes/dev.json.

  // An agent ended with its worktree removed (after the merge) is continued in the same place: the worktree is
  // made again there, on its branch if it is still there, else on the same name from the integration branch,
  // which has its work. The same path lets the agent find its conversation.
  ctx.workspaces.registerRestorer({
    offer: (session, task) => {
      const meta = own(task.id);
      if (!meta.repo || !meta.worktree || !meta.branch || !inside(meta.worktree, session.cwd)) return undefined;
      if (existsSync(meta.worktree) || !existsSync(meta.repo)) return undefined;
      return "dev-flow.restoreWorktree";
    },
    restore: (session, task) => {
      const meta = own(task.id);
      const repo = meta.repo!;
      const worktree = meta.worktree!;
      const base = setting<string>("integrationBranch", task);
      let branch = meta.branch!;
      if (meta.branchDeleted || !branchExists(repo, branch)) {
        // The name may have gone to another task's branch since.
        if (branchExists(repo, branch)) branch = freeSlug(repo, dirname(worktree), branch);
        const from = branchExists(repo, base) ? base : meta.commit;
        if (!from) throw new Error(`Neither ${base} nor the task's last commit is there to restore ${worktree} from`);
        restoreWorktree(repo, worktree, branch, from);
      } else {
        restoreWorktree(repo, worktree, branch);
      }
      copyIgnored(repo, worktree, setting<string[]>("copyFiles", task) ?? []);
      saveMeta(task.id, { branch, branchDeleted: false });
      ctx.tasks.update(task.id, { workspace: join(worktree, meta.sub ?? "") });
      return session.cwd;
    },
  });

  // What the agent says with `pitwall`

  ctx.agents.onSignal({
    name: "done",
    description: '"<what you did>": the work is finished; the app runs the tests and tells you what fails',
    handler: ({ task }) => {
      const run = ctx.processes.run(task.id);
      if (run?.process !== PROCESS) return "This task has no development process: tell the user instead.";
      if (run.state !== "waiting" || run.node !== "wait") return `Nothing waits for that now: the process is at ${run.node} (${run.state}).`;
      ctx.processes.resume(task.id, "done");
      return "Thanks. The app runs the tests now and sends you what fails.";
    },
  });

  ctx.agents.onSignal({
    name: "spec",
    description: '"<markdown>": rewrite the task\'s description (or pipe a file into it)',
    handler: ({ task, text }) => {
      if (!text.trim()) throw new Error("Give the new description as text or on stdin");
      saveMeta(task.id, { spec: text.trim() });
      return "The description is updated.";
    },
  });

  ctx.agents.onSignal({
    name: "rename",
    description: '"<title>": rename the task',
    handler: ({ task, text }) => {
      if (!text.trim()) throw new Error("Give the new title");
      ctx.tasks.update(task.id, { title: text.trim().slice(0, 120) });
      return "Renamed.";
    },
  });

  // A quiet agent is asked whether it finished: once per quiet spell, not while it asks the user or the user
  // types, nor while it waits for its usage limit to reset (busy), and its quiet counts from the end of that wait.
  // It is asked again only after the user typed, or after it worked for a minute since.

  const nudged = new Map<string, number>();
  const waited = new Map<string, number>();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const task of ctx.tasks.list()) {
      const run = ctx.processes.run(task.id);
      if (run?.process !== PROCESS || run.state !== "waiting" || run.node !== "wait") continue;
      const session = runningSession(task.id);
      if (session?.waiting) waited.set(session.id, now);
      if (!session || session.busy || session.asking || !session.lastOutputAt) continue;
      const idle = (setting<number>("idleSeconds", task) ?? 5) * 1000;
      if (now - Math.max(session.lastOutputAt, waited.get(session.id) ?? 0) < idle) continue;
      if (session.lastInputAt && now - session.lastInputAt < Math.max(idle, 30_000)) continue;
      const last = nudged.get(session.id);
      if (last && !(session.lastInputAt && session.lastInputAt > last) && session.lastOutputAt - last < 60_000) continue;
      nudged.set(session.id, now);
      try {
        ctx.agents.send(session.id, nudge);
      } catch {}
    }
  }, 1000);
  timer.unref();
  ctx.events.on("app.stopping", () => {
    stopped = true;
    clearInterval(timer);
    stands.stopAll();
  });

  // Stands do not survive the app; a task waiting for the user's verdict gets its stand back, on its port.
  setImmediate(() => {
    if (stopped) return;
    for (const task of ctx.tasks.list()) {
      const run = ctx.processes.run(task.id);
      const meta = own(task.id);
      const command = setting<string>("standCommand", task)?.trim();
      if (run?.process !== PROCESS || run.state !== "waiting" || run.node !== "stand") continue;
      if (command && meta.standDir && existsSync(meta.standDir)) void stands.start(task.id, command, meta.standDir, meta.standPort);
    }
  });
  ctx.events.on("task.deleted", (task: Task) => stands.stop(task.id));
  ctx.events.on("task.archived", (task: Task) => {
    stands.stop(task.id);
    wakeWaiting();
  });
});
