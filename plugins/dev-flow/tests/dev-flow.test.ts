import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { definePlugin, type AgentProvider } from "../../../src/sdk/server.ts";
import type { Core } from "../../../src/server/app.ts";
import { root, testCore, waitFor } from "../../../test/helpers.ts";
import { parseRefined, refinePrompt, SUGGESTION_MAX, withAnswers } from "../prompts.ts";
import { toSlug } from "../git.ts";
import { installCommand, standLink } from "../shell.ts";

const posix = process.platform !== "win32";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** A repository with a commit on main and on dev, and an ignored .env. */
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "dev-flow-repo-"));
  dirs.push(dir, `${dir}-worktrees`);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "Test");
  writeFileSync(join(dir, ".gitignore"), ".env\n");
  writeFileSync(join(dir, ".env"), "SECRET=1\n");
  writeFileSync(join(dir, "README.md"), "hi\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "first");
  git(dir, "branch", "dev");
  return dir;
}

const refined = JSON.stringify({ slug: "Add login!", title: "Add login", spec: "## Goal\nA login page" });

async function setup(settings: Record<string, string> = {}, folderPath?: string, answer = refined, agent: Partial<AgentProvider> = {}) {
  const core = await testCore({
    pluginsDir: join(root, "plugins"),
    defaultProvider: "fake",
    settings: {
      cli: {
        // Passes once the agent made the file `ok`.
        "dev-flow.testCommand": "test -f ok",
        "dev-flow.standCommand": `node -e "require('http').createServer((q, s) => s.end('stand')).listen(process.env.PORT)"`,
        ...settings,
      },
    },
  });
  await core.plugins.load(
    "fake-agent",
    { permissions: { "agents:provide": "" } },
    definePlugin((ctx) =>
      ctx.agents.registerProvider({
        id: "fake",
        label: "Fake agent",
        command: "sh",
        // Echoes what it is sent, so the test can see it.
        args: ({ prompt }) => ["-c", 'printf "%s\\n" "$1"; exec cat', "fake", prompt ?? ""],
        exec: () => ["-c", `printf '%s' '${answer}'`],
        ...agent,
      }),
    ),
  );
  const folder = core.store.createFolder({ name: "F", meta: folderPath ? { "local-dir": { path: folderPath } } : {} });
  const task = core.processes.createTask({ folderId: folder.id, title: "New task" }, "dev-flow.dev");
  return { core, task };
}

/** Answers the creation form and waits until the agent works. */
async function startWork(core: Core, taskId: string) {
  await core.processes.settled(taskId);
  core.processes.resume(taskId, { prompt: "Add a login page" });
  expect(await core.processes.settled(taskId)).toMatchObject({ state: "waiting", node: "wait" });
}

const done = async (core: Core, taskId: string) => {
  const session = core.sessions.list(taskId).at(-1)!;
  expect(await core.sessions.signal(session, "done", "did it")).toMatch(/runs the tests/);
  return core.processes.settled(taskId);
};

const meta = (core: Core, taskId: string) => core.store.task(taskId)!.meta["dev-flow"] as Record<string, any>;

describe("dev-flow helpers", () => {
  it("makes branch names of anything", () => {
    expect(toSlug("Add login!  Page")).toBe("add-login-page");
    expect(toSlug("Вход")).toBe("task");
    expect(toSlug("a".repeat(80))).toHaveLength(50);
  });

  it("reads the naming agent's JSON, even with prose around it, and falls back to the request", () => {
    expect(parseRefined(`Sure:\n${refined}\n`, "x")).toEqual({
      slug: "add-login",
      title: "Add login",
      spec: "## Goal\nA login page",
      questions: [],
    });
    expect(parseRefined(JSON.stringify({ title: "T", questions: [" Which page? ", 3, ""] }), "x").questions).toEqual([{ question: "Which page?" }]);
    expect(parseRefined("no json", "Fix the header\nIt is too tall")).toEqual({
      slug: "fix-the-header",
      title: "Fix the header",
      spec: "Fix the header\nIt is too tall",
      questions: [],
    });
  });

  it("reads each question's likely answer and shows none longer than 250 characters, never cutting one", () => {
    const questions = [
      { question: "Which page?", answer: " The main one " },
      { question: "Size?", answer: "x".repeat(SUGGESTION_MAX) },
      { question: "Color?", answer: "x".repeat(SUGGESTION_MAX + 1) },
      { question: "Why?", answer: "" },
    ];
    const parsed = parseRefined(JSON.stringify({ title: "T", questions }), "x").questions;
    expect(parsed[0]).toEqual({ question: "Which page?", suggestion: "The main one" });
    expect(parsed[1].suggestion).toHaveLength(SUGGESTION_MAX);
    expect(parsed[2]).toEqual({ question: "Color?" });
    expect(parsed[3]).toEqual({ question: "Why?" });
    expect(SUGGESTION_MAX).toBe(250);
    expect(refinePrompt("x")).toContain('"answer"');
    expect(refinePrompt("x")).toContain(`at most ${SUGGESTION_MAX} characters`);
  });

  it("reads questions with options, one or several, and an answer of the user's own", () => {
    const questions = [
      { question: "Database?", options: ["SQLite", " Postgres ", "SQLite"], answer: "Postgres" },
      { question: "Systems?", options: ["Linux", "macOS", "Windows"], multiple: true, answer: ["Linux", "macOS"] },
      { question: "Port?", options: ["80", "8080"], answer: "4870" },
      { question: "One option is no choice", options: ["Yes"], answer: "Yes" },
    ];
    expect(parseRefined(JSON.stringify({ title: "T", questions }), "x").questions).toEqual([
      { question: "Database?", options: ["SQLite", "Postgres"], suggestion: "Postgres" },
      { question: "Systems?", options: ["Linux", "macOS", "Windows"], multiple: true, suggestion: ["Linux", "macOS"] },
      { question: "Port?", options: ["80", "8080"], suggestion: "4870" },
      { question: "One option is no choice", suggestion: "Yes" },
    ]);
  });

  it("puts what the agent decided itself into the spec as assumptions", () => {
    const refined = parseRefined(JSON.stringify({ title: "T", spec: "## Goal", assumptions: [" Blue button ", ""], questions: [] }), "x");
    expect(refined.spec).toBe("## Goal\n\n## Assumptions\n\n- Blue button");
    expect(parseRefined(JSON.stringify({ title: "T", spec: "## Goal" }), "x").spec).toBe("## Goal");
    expect(refinePrompt("x")).toMatch(/\[\] is the normal answer/);
  });

  it("adds the answered questions to the spec", () => {
    const qs = [{ question: "Which page?", suggestion: "The main one" }, { question: "Color?" }];
    expect(withAnswers("## Goal", qs, { q0: "The main one", q1: " " })).toBe(
      "## Goal\n\n## Clarifications\n\n- Which page?\n  The main one",
    );
    expect(withAnswers("## Goal", [{ question: "Systems?", options: ["Linux", "macOS"], multiple: true }], { q0: ["Linux", "FreeBSD"] })).toBe(
      "## Goal\n\n## Clarifications\n\n- Systems?\n  Linux, FreeBSD",
    );
    // A suggestion nobody took goes nowhere.
    expect(withAnswers("## Goal", qs, {})).toBe("## Goal");
  });
});

describe("dev stand of this app", () => {
  it("has the script the default stand command runs, and gets its own data and the link with the token", () => {
    const scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts;
    expect(scripts.dev).toMatch(/scripts\/dev\.ts/);
    const dev = readFileSync(join(root, "scripts/dev.ts"), "utf8");
    expect(dev).toMatch(/--data-dir/);
    expect(dev).toMatch(/PITWALL_SERVER_CHILD/);
  });

  it("installs a JavaScript worktree's dependencies by its lockfile, once", () => {
    const dir = mkdtempSync(join(tmpdir(), "dev-flow-install-"));
    dirs.push(dir);
    expect(installCommand(dir)).toBeUndefined();
    writeFileSync(join(dir, "package.json"), "{}");
    expect(installCommand(dir)).toBeUndefined();
    writeFileSync(join(dir, "pnpm-lock.yaml"), "");
    expect(installCommand(dir)).toMatch(/^pnpm install/);
    mkdirSync(join(dir, "node_modules"));
    expect(installCommand(dir)).toBeUndefined();
  });
});

describe.skipIf(!posix)("dev-flow", () => {
  it("is registered with its statuses and can run", async () => {
    const { core } = await setup();
    const def = core.processes.list().find((w) => w.id === "dev-flow.dev");
    expect(def).toMatchObject({ problems: [], doneStatus: "in_dev", icon: "git-branch" });
  });

  it(
    "goes from the user's words through a worktree, failing tests, a comment and the stand into dev",
    async () => {
      const dir = repo();
      const { core, task } = await setup({}, dir);
      await startWork(core, task.id);

      // Named by the agent, with the refined description, in a worktree from dev with .env copied.
      const worktree = `${dir}-worktrees/add-login`;
      expect(core.store.task(task.id)).toMatchObject({ title: "Add login", body: "Add a login page", workspace: worktree });
      expect(meta(core, task.id)).toMatchObject({ spec: "## Goal\nA login page", branch: "add-login", repo: dir });
      expect(git(worktree, "rev-parse", "--abbrev-ref", "HEAD")).toBe("add-login");
      expect(readFileSync(join(worktree, ".env"), "utf8")).toBe("SECRET=1\n");
      const [session] = core.sessions.list(task.id);
      expect(session.cwd).toBe(worktree);
      await waitFor(() => core.sessions.scrollback(session.id).includes("pitwall done"));

      // The tests fail: their output goes to the same agent.
      expect(await done(core, task.id)).toMatchObject({ state: "waiting", node: "wait" });
      await waitFor(() => core.sessions.scrollback(session.id).includes("The tests failed"));
      expect(core.sessions.list(task.id)).toHaveLength(1);

      // They pass: the process waits for manual testing, and the stand starts on the user's word.
      writeFileSync(join(worktree, "ok"), "");
      const manual = await done(core, task.id);
      expect(manual).toMatchObject({ state: "waiting", node: "manual" });
      expect(manual?.request).toMatchObject({
        title: "Разработка и автотестирование завершены. Ждём ручного тестирования",
        options: [{ id: "stand", label: "Стартовать dev сервер" }, { id: "ready" }, { id: "back" }],
      });
      expect(core.store.task(task.id)?.status).toBe("review");
      core.processes.resume(task.id, "stand");
      const review = await core.processes.settled(task.id);
      expect(review).toMatchObject({ state: "waiting", node: "stand" });
      const url = review?.request?.body?.match(/http:\/\/localhost:\d+/)?.[0];
      expect(await (await fetch(url!)).text()).toBe("stand");
      // The task's page shows where the stand runs.
      const stand = await core.plugins.loaded.get("dev-flow")!.rpc.get("stand")!({ taskId: task.id });
      expect(stand).toMatchObject({ url, dir: worktree, branch: "add-login", running: true });

      // Back to the agent with a comment.
      core.processes.resume(task.id, "back");
      expect(await core.processes.settled(task.id)).toMatchObject({ state: "waiting", node: "stand", request: { kind: "form" } });
      core.processes.resume(task.id, { comment: "Make the button blue" });
      expect(await core.processes.settled(task.id)).toMatchObject({ state: "waiting", node: "wait" });
      await waitFor(() => core.sessions.scrollback(session.id).includes("Make the button blue"));
      await expect(fetch(url!)).rejects.toThrow();

      // Ready without a stand this time: merged into dev, tested there, the worktree gone.
      expect(await done(core, task.id)).toMatchObject({ node: "manual" });
      core.processes.resume(task.id, "ready");
      expect(await core.processes.settled(task.id)).toMatchObject({ state: "done" });
      expect(core.store.task(task.id)).toMatchObject({ status: "in_dev", workspace: null });
      expect(git(dir, "log", "dev", "-1", "--format=%s")).toBe("Merge add-login: Add login");
      expect(git(dir, "show", "dev:ok")).toBe("");
      expect(existsSync(worktree)).toBe(false);
      // Its agent ended with it: a restart has nothing to continue in a removed directory.
      await waitFor(() => core.sessions.get(session.id)!.state === "exited");
      expect(core.sessions.get(session.id)).toMatchObject({ exitReason: "dev-flow.merged" });
      // The branch went too, its work being in dev; its last commit is kept on the task.
      expect(git(dir, "branch", "--list", "add-login")).toBe("");
      expect(meta(core, task.id)).toMatchObject({ branchDeleted: true, commit: git(dir, "rev-parse", "dev^2") });

      // Continuing the agent brings the worktree back where it was, on the same name from the current dev.
      expect(core.sessions.continuation(session.id)).toMatchObject({ possible: true, gone: true, restore: "dev-flow.restoreWorktree" });
      core.sessions.continue(session.id);
      expect(core.sessions.get(session.id)).toMatchObject({ state: "running", cwd: worktree });
      expect(git(worktree, "rev-parse", "--abbrev-ref", "HEAD")).toBe("add-login");
      expect(git(worktree, "rev-parse", "HEAD")).toBe(git(dir, "rev-parse", "dev"));
      expect(readFileSync(join(worktree, ".env"), "utf8")).toBe("SECRET=1\n");
      expect(core.store.task(task.id)).toMatchObject({ workspace: worktree });
      expect(meta(core, task.id)).toMatchObject({ branch: "add-login", branchDeleted: false });
    },
    30_000,
  );

  it("asks the naming agent's questions before the work and passes the answers to the agent", async () => {
    const answer = JSON.stringify({
      slug: "login",
      title: "Add login",
      spec: "## Goal\nA login page",
      questions: [
        { question: "Which page?", answer: "The main one" },
        { question: "Database?", options: ["SQLite", "Postgres"], answer: "SQLite" },
      ],
    });
    const { core, task } = await setup({ "dev-flow.standCommand": "" }, undefined, answer);
    await core.processes.settled(task.id);
    core.processes.resume(task.id, { prompt: "Add a login page" });
    expect(await core.processes.settled(task.id)).toMatchObject({
      state: "waiting",
      node: "clarify",
      request: {
        kind: "form",
        fields: [
          { id: "q0", label: "Which page?", multiline: true, suggestion: "The main one" },
          { id: "q1", label: "Database?", options: ["SQLite", "Postgres"], other: true, suggestion: "SQLite" },
        ],
      },
    });
    core.processes.resume(task.id, { q0: "тест пройден", q1: "MySQL" });
    expect(await core.processes.settled(task.id)).toMatchObject({ state: "waiting", node: "wait" });
    expect(meta(core, task.id).spec).toContain("- Which page?\n  тест пройден\n- Database?\n  MySQL");
    const [session] = core.sessions.list(task.id);
    await waitFor(() => core.sessions.scrollback(session.id).includes("тест пройден"));
  });

  it("takes the merge back when the tests fail on dev, and returns the task to its agent", async () => {
    const dir = repo();
    // On dev the last commit is the merge: the tests fail there only.
    const { core, task } = await setup({ "dev-flow.testCommand": "! git log -1 --format=%s | grep -q ^Merge", "dev-flow.standCommand": "" }, dir);
    await startWork(core, task.id);
    writeFileSync(join(core.store.task(task.id)!.workspace!, "feature.txt"), "x");
    expect(await done(core, task.id)).toMatchObject({ node: "manual" });
    const before = git(dir, "rev-parse", "dev");
    core.processes.resume(task.id, "ready");
    expect(await core.processes.settled(task.id)).toMatchObject({ state: "waiting", node: "wait" });
    expect(git(dir, "rev-parse", "dev")).toBe(before);
    const [session] = core.sessions.list(task.id);
    await waitFor(() => core.sessions.scrollback(session.id).includes("the merge was taken back"));
  });

  it("merges one task at a time: the second waits for dev and goes on by itself", async () => {
    const dir = repo();
    const { core, task: first } = await setup({ "dev-flow.testCommand": "sleep 1", "dev-flow.standCommand": "" }, dir);
    const second = core.processes.createTask({ folderId: first.folderId, title: "New task" }, "dev-flow.dev");
    await startWork(core, first.id);
    await startWork(core, second.id);
    expect(meta(core, second.id).branch).toBe("add-login-2");
    for (const t of [first, second]) writeFileSync(join(core.store.task(t.id)!.workspace!, `${t.id}.txt`), "x");
    expect(await done(core, first.id)).toMatchObject({ node: "manual" });
    expect(await done(core, second.id)).toMatchObject({ node: "manual" });

    core.processes.resume(first.id, "ready");
    await waitFor(() => core.processes.run(first.id)?.node === "test-dev");
    core.processes.resume(second.id, "ready");
    expect(await core.processes.settled(second.id)).toMatchObject({ state: "waiting", node: "merge" });
    expect(core.processes.run(second.id)?.request?.body).toContain('"Add login" is merging into dev');

    expect(await core.processes.settled(first.id)).toMatchObject({ state: "done" });
    await waitFor(() => core.processes.run(second.id)?.state === "done", 10_000).catch(() => {
      throw new Error(JSON.stringify(core.processes.run(second.id)));
    });
    expect(git(dir, "log", "dev", "--first-parent", "--format=%s").split("\n").slice(0, 2)).toEqual([
      "Merge add-login-2: Add login",
      "Merge add-login: Add login",
    ]);
  }, 30_000);

  it("stops with an error when the integration branch does not exist", async () => {
    const dir = repo();
    const { core, task } = await setup({ "dev-flow.integrationBranch": "develop" }, dir);
    await core.processes.settled(task.id);
    core.processes.resume(task.id, { prompt: "Add a login page" });
    const run = await core.processes.settled(task.id);
    expect(run).toMatchObject({ state: "failed", node: "workspace" });
    expect(run?.error).toContain("No branch develop");
  });

  it("without git works in the folder and ends without merging", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dev-flow-plain-"));
    dirs.push(dir);
    writeFileSync(join(dir, "ok"), "");
    const { core, task } = await setup({ "dev-flow.standCommand": "" }, dir);
    await startWork(core, task.id);
    expect(core.sessions.list(task.id)[0].cwd).toBe(dir);
    expect(await done(core, task.id)).toMatchObject({ node: "manual" });
    core.processes.resume(task.id, "ready");
    expect(await core.processes.settled(task.id)).toMatchObject({ state: "done" });
    expect(core.store.task(task.id)?.status).toBe("in_dev");
  });

  it("shows a stand that did not start with its output, and starts it again", async () => {
    const dir = repo();
    const { core, task } = await setup({ "dev-flow.standCommand": "echo port taken; exit 1" }, dir);
    await startWork(core, task.id);
    writeFileSync(join(`${dir}-worktrees/add-login`, "ok"), "");
    expect(await done(core, task.id)).toMatchObject({ node: "manual" });
    core.processes.resume(task.id, "stand");
    const failed = await core.processes.settled(task.id);
    expect(failed).toMatchObject({ state: "waiting", node: "stand", request: { title: "The dev stand did not start", body: "port taken" } });
    expect(failed?.request).toMatchObject({ options: [{ id: "retry" }, { id: "ready" }, { id: "back" }] });
    core.processes.resume(task.id, "retry");
    expect(await core.processes.settled(task.id)).toMatchObject({ state: "waiting", node: "stand", request: { title: "The dev stand did not start" } });
    core.processes.resume(task.id, "ready");
    expect(await core.processes.settled(task.id)).toMatchObject({ state: "done" });
  }, 30_000);

  it("starts the stand of a fresh worktree that has no node_modules yet", async () => {
    const dir = repo();
    // Like this app: `pnpm run dev`, which needs the dependencies, and node_modules ignored.
    const server = `require('http').createServer((q, s) => s.end('stand')).listen(process.env.PORT)`;
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", private: true, scripts: { dev: `test -d node_modules && node -e "${server}"` } }));
    writeFileSync(join(dir, ".gitignore"), ".env\nnode_modules\n");
    execFileSync("pnpm", ["install", "--lockfile-only"], { cwd: dir });
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "js");
    git(dir, "branch", "-f", "dev");
    const { core, task } = await setup({ "dev-flow.standCommand": "pnpm run dev" }, dir);
    await startWork(core, task.id);
    // Installed with the worktree, before the agent starts in it.
    expect(existsSync(join(`${dir}-worktrees/add-login`, "node_modules"))).toBe(true);
    expect(meta(core, task.id).installFailed).toBeUndefined();
    writeFileSync(join(`${dir}-worktrees/add-login`, "ok"), "");
    expect(await done(core, task.id)).toMatchObject({ node: "manual" });
    core.processes.resume(task.id, "stand");
    expect(await core.processes.settled(task.id)).toMatchObject({ node: "stand", request: { title: "Try the work on the dev stand" } });
    expect(await (await fetch(`http://127.0.0.1:${meta(core, task.id).standPort}`)).text()).toBe("stand");
    core.processes.resume(task.id, "ready");
    expect(await core.processes.settled(task.id)).toMatchObject({ state: "done" });
  }, 30_000);

  it("goes on when the worktree's dependencies do not install, with a warning that leads to a fix", async () => {
    const dir = repo();
    // The lockfile does not match package.json: a frozen install fails at once, without the network.
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", private: true, dependencies: { "left-pad": "1.3.0" } }));
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    writeFileSync(join(dir, ".gitignore"), ".env\nnode_modules\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "js");
    git(dir, "branch", "-f", "dev");
    const { core, task } = await setup({}, dir);
    await startWork(core, task.id);
    const worktree = `${dir}-worktrees/add-login`;
    const failed = meta(core, task.id).installFailed;
    expect(failed).toMatchObject({ dir: worktree, output: expect.stringMatching(/^\$ pnpm install/) });
    expect(failed.request).toContain(worktree);
    expect(failed.request).toContain("plugins/dev-flow");
    expect(core.sessions.list(task.id)).toHaveLength(1);
    await core.plugins.loaded.get("dev-flow")!.rpc.get("dismissInstall")!({ taskId: task.id });
    expect(meta(core, task.id).installFailed).toBeNull();
  }, 30_000);

  it("lets the agent rename the task and rewrite its description", async () => {
    const { core, task } = await setup();
    await startWork(core, task.id);
    const session = core.sessions.list(task.id)[0];
    await core.sessions.signal(session, "rename", "Login page");
    await core.sessions.signal(session, "spec", "## Goal\nBetter");
    expect(core.store.task(task.id)?.title).toBe("Login page");
    expect(meta(core, task.id).spec).toBe("## Goal\nBetter");
    expect(await core.sessions.signal(session, "help", "")).toMatch(/pitwall done/);
  });

  it("asks a quiet agent once whether it is finished", async () => {
    const { core, task } = await setup({ "dev-flow.idleSeconds": "1" });
    await startWork(core, task.id);
    const session = core.sessions.list(task.id)[0];
    const asked = () => core.sessions.scrollback(session.id).split("Are you finished?").length - 1;
    await waitFor(() => asked() > 0, 10_000);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const once = asked(); // the terminal echoes it, and the agent prints it back
    await new Promise((resolve) => setTimeout(resolve, 6000));
    expect(asked()).toBe(once);
  }, 20_000);

  it("does not ask an agent that waits for its usage limit to reset", async () => {
    let limited = true;
    const { core, task } = await setup({ "dev-flow.idleSeconds": "3" }, undefined, refined, { waits: () => limited });
    await startWork(core, task.id);
    const session = core.sessions.list(task.id)[0];
    const asked = () => core.sessions.scrollback(session.id).includes("Are you finished?");
    await waitFor(() => core.sessions.get(session.id)!.waiting, 10_000);
    await new Promise((resolve) => setTimeout(resolve, 5000));
    expect(asked()).toBe(false);
    // The message is gone: not asked at once, but after the usual quiet, as before.
    limited = false;
    await waitFor(() => !core.sessions.get(session.id)!.waiting, 3000);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(asked()).toBe(false);
    await waitFor(asked, 10_000);
  }, 30_000);
});

describe("standLink", () => {
  it("takes the address the stand prints for its port, with its token", () => {
    const output = "\x1b[32mready\x1b[0m on http://127.0.0.1:4871/?token=abc123.\nother http://localhost:9999\n";
    expect(standLink(output, 4871)).toBe("http://127.0.0.1:4871/?token=abc123");
  });

  it("falls back to localhost and the port", () => {
    expect(standLink("listening on http://localhost:48710", 4871)).toBe("http://localhost:4871");
    expect(standLink("", 5000)).toBe("http://localhost:5000");
  });
});
