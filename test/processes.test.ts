import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { definePlugin, type PluginContext } from "../src/sdk/server.ts";
import { createCore, type Core } from "../src/server/app.ts";
import { startHttp } from "../src/server/http.ts";
import { root, testCore } from "./helpers.ts";

const permissions = {
  "statuses:register": "test",
  "tasks:guard": "test",
  "steps:register": "test",
  "processes:register": "test",
  "processes:run": "test",
};

/** Loads a plugin "flow" whose setup gets its context. */
async function withPlugin(core: Core, setup: (ctx: PluginContext) => void) {
  let ctx!: PluginContext;
  await core.plugins.load(
    "flow",
    { permissions },
    definePlugin((c) => {
      ctx = c;
      setup(c);
    }),
  );
  return ctx;
}

function newTask(core: Core, body = "") {
  const folder = core.store.createFolder({ name: "F" });
  return core.store.createTask({ folderId: folder.id, title: "T", body });
}

describe("processes", () => {
  it("checks the contract between steps before running", async () => {
    const core = await testCore();
    await withPlugin(core, (ctx) => {
      ctx.steps.register({ id: "name", label: "Name", reads: ["task.title?"], writes: ["name.title"], run: () => ({}) });
      ctx.steps.register({ id: "branch", label: "Branch", reads: ["name.title", "github.issue"], run: () => {} });
      ctx.processes.register({
        id: "broken",
        label: "Broken",
        nodes: { name: "name", branch: "branch", ghost: "other.step" },
        edges: [
          ["start", "name"],
          ["name", "branch"],
          ["branch", "nowhere"],
        ],
      });
    });
    expect(core.processes.list()[0].problems).toEqual([
      "Node branch: flow.branch reads github.issue, which no step writes",
      "Node ghost: no step other.step; is its plugin installed and enabled?",
      "Edge to nowhere: no such node",
      "Node name: no way from it to the end",
      "Node branch: no way from it to the end",
      "Node ghost: nothing leads to it",
    ]);
    const task = newTask(core);
    expect(() => core.processes.start(task.id, "flow.broken")).toThrow(/cannot run: Node branch/);
    expect(core.processes.run(task.id)).toBeUndefined();
  });

  it("refuses keys that are not namespaced and nodes named after the ends", async () => {
    const core = await testCore();
    const ctx = await withPlugin(core, () => {});
    expect(() => ctx.steps.register({ id: "s", label: "S", writes: ["title"], run: () => {} })).toThrow(/namespace/);
    expect(() =>
      ctx.processes.register({ id: "w", label: "W", nodes: { start: "s" }, edges: [] }),
    ).toThrow(/cannot be named "start"/);
  });

  it("runs steps in order, each seeing only the keys it reads", async () => {
    const core = await testCore();
    const seen: unknown[] = [];
    await withPlugin(core, (ctx) => {
      ctx.steps.register({
        id: "name",
        label: "Name",
        writes: ["name.title", "name.secret"],
        run: ({ task, params }) => ({ "name.title": `${params.prefix}${task.body}`, "name.secret": 42 }),
      });
      ctx.steps.register({
        id: "use",
        label: "Use",
        reads: ["name.title", "request.provider"],
        writes: ["use.done"],
        run: ({ state }) => {
          seen.push(state);
          return { "use.done": true };
        },
      });
      ctx.processes.register({
        id: "simple",
        label: "Simple",
        inputs: ["request.provider"],
        nodes: { name: { step: "name", params: { prefix: "Fix: " } }, use: "use" },
        edges: [
          ["start", "name"],
          ["name", "use"],
          ["use", "end"],
        ],
      });
    });
    const task = newTask(core, "login");
    expect(core.processes.start(task.id, "flow.simple", { "request.provider": "codex" }).state).toBe("running");
    expect(await core.processes.settled(task.id)).toMatchObject({ state: "done", node: null, error: null });
    expect(seen).toEqual([{ "name.title": "Fix: login", "request.provider": "codex" }]);
    expect(() => core.processes.start(task.id, "flow.simple")).toThrow(/already follows Simple/);
    expect(core.state().processes.runs).toHaveLength(1);
  });

  it("fails a step that writes what it did not declare, and retries it", async () => {
    const core = await testCore();
    let sneaky = true;
    await withPlugin(core, (ctx) => {
      ctx.steps.register({
        id: "s",
        label: "S",
        writes: ["s.ok"],
        run: () => (sneaky ? { "s.ok": 1, "other.key": 2 } : { "s.ok": 1 }),
      });
      ctx.processes.register({ id: "w", label: "W", nodes: { s: "s" }, edges: [["start", "s"], ["s", "end"]] });
    });
    const task = newTask(core);
    core.processes.start(task.id, "flow.w");
    expect(await core.processes.settled(task.id)).toMatchObject({
      state: "failed",
      node: "s",
      error: "Step flow.s returned other.key, which it does not declare in writes",
    });
    sneaky = false;
    core.processes.retry(task.id);
    expect(await core.processes.settled(task.id)).toMatchObject({ state: "done", error: null });
  });

  it("waits for the user, checks the answer and branches on it", async () => {
    const core = await testCore();
    const ran: string[] = [];
    await withPlugin(core, (ctx) => {
      ctx.steps.register({
        id: "review",
        label: "Review",
        writes: ["review.decision"],
        run: ({ ask }) => ({
          "review.decision": ask({
            kind: "choice",
            title: "Ready?",
            options: [
              { id: "back", label: "Back to development" },
              { id: "ship", label: "Ready to ship", primary: true },
            ],
          }),
        }),
      });
      for (const id of ["develop", "ship"]) {
        ctx.steps.register({ id, label: id, run: () => void ran.push(id) });
      }
      ctx.processes.register({
        id: "w",
        label: "W",
        nodes: { review: "review", develop: "develop", ship: "ship" },
        edges: [
          ["start", "review"],
          ["review", (s) => (s["review.decision"] === "ship" ? "ship" : "develop"), ["ship", "develop"]],
          ["develop", "review"],
          ["ship", "end"],
        ],
      });
    });
    const task = newTask(core);
    core.processes.start(task.id, "flow.w");
    const waiting = await core.processes.settled(task.id);
    expect(waiting).toMatchObject({ state: "waiting", node: "review", request: { kind: "choice", title: "Ready?" } });

    expect(() => core.processes.resume(task.id, "maybe")).toThrow(/one of back, ship/);
    core.processes.resume(task.id, "back");
    expect(await core.processes.settled(task.id)).toMatchObject({ state: "waiting", node: "review" });
    core.processes.resume(task.id, "ship");
    expect(await core.processes.settled(task.id)).toMatchObject({ state: "done" });
    expect(ran).toEqual(["develop", "ship"]);
  });

  it("checks form answers", async () => {
    const core = await testCore();
    await withPlugin(core, (ctx) => {
      ctx.steps.register({
        id: "clarify",
        label: "Clarify",
        writes: ["clarify.answers"],
        run: ({ ask }) => ({
          "clarify.answers": ask({
            kind: "form",
            title: "Questions",
            fields: [{ id: "scope", label: "Scope", required: true }],
          }),
        }),
      });
      ctx.processes.register({ id: "w", label: "W", nodes: { c: "clarify" }, edges: [["start", "c"], ["c", "end"]] });
    });
    const task = newTask(core);
    core.processes.start(task.id, "flow.w");
    await core.processes.settled(task.id);
    expect(() => core.processes.resume(task.id, { scope: " " })).toThrow(/Scope is required/);
    core.processes.resume(task.id, { scope: "only the login page" });
    expect(await core.processes.settled(task.id)).toMatchObject({ state: "done" });
  });

  it("takes picked options as answers: one, several, or the user's own with Other", async () => {
    const core = await testCore();
    await withPlugin(core, (ctx) => {
      ctx.steps.register({
        id: "pick",
        label: "Pick",
        writes: ["pick.answers"],
        run: ({ ask }) => ({
          "pick.answers": ask({
            kind: "form",
            title: "Questions",
            fields: [
              { id: "db", label: "Database", options: ["SQLite", "Postgres"], required: true },
              { id: "os", label: "Systems", options: ["Linux", "macOS"], multiple: true, other: true },
            ],
          }),
        }),
      });
      ctx.processes.register({ id: "w", label: "W", nodes: { p: "pick" }, edges: [["start", "p"], ["p", "end"]] });
    });
    const task = newTask(core);
    core.processes.start(task.id, "flow.w");
    await core.processes.settled(task.id);
    expect(() => core.processes.resume(task.id, { db: "MySQL" })).toThrow(/MySQL is not one of SQLite, Postgres/);
    expect(() => core.processes.resume(task.id, { db: "SQLite", os: "Linux" })).toThrow(/expected a list/);
    expect(() => core.processes.resume(task.id, { os: ["Linux"] })).toThrow(/Database is required/);
    core.processes.resume(task.id, { db: "SQLite", os: ["Linux", "FreeBSD"] });
    expect(await core.processes.settled(task.id)).toMatchObject({ state: "done" });
  });

  it("forgets a deleted task's checkpoints", async () => {
    const core = await testCore();
    await withPlugin(core, (ctx) => {
      ctx.steps.register({ id: "s", label: "S", run: () => {} });
      ctx.processes.register({ id: "w", label: "W", nodes: { s: "s" }, edges: [["start", "s"], ["s", "end"]] });
    });
    const task = newTask(core);
    core.processes.start(task.id, "flow.w");
    await core.processes.settled(task.id);
    const count = () => (core.db.prepare("SELECT count(*) AS n FROM checkpoints").get() as { n: number }).n;
    expect(count()).toBeGreaterThan(0);
    core.store.deleteTask(task.id);
    expect(count()).toBe(0);
    expect(core.processes.run(task.id)).toBeUndefined();
  });
});

describe("process statuses", () => {
  /** develop → review ⇄ develop, review → ship → end; the review question moves the task. */
  const plugin = (ctx: PluginContext) => {
    ctx.statuses.register([
      { id: "review", label: "Review", color: "amber", category: "active" },
      { id: "ready", label: "Ready to ship", color: "violet", category: "active" },
    ]);
    // Another plugin's rule; the process's own moves do not go through it.
    ctx.tasks.guardTransition(() => "No manual moves");
    ctx.steps.register({ id: "develop", label: "Develop", run: () => {} });
    ctx.steps.register({ id: "ship", label: "Ship", run: () => {} });
    ctx.steps.register({
      id: "review",
      label: "Review",
      writes: ["review.decision"],
      run: ({ ask }) => ({
        "review.decision": ask({
          kind: "choice",
          title: "Check it",
          options: [
            { id: "back", label: "Back to development", status: "in_progress" },
            { id: "ship", label: "Ready to ship", status: "ready", primary: true },
          ],
        }),
      }),
    });
    ctx.processes.register({
      id: "dev",
      label: "Development",
      nodes: {
        develop: { step: "develop", status: "in_progress" },
        review: { step: "review", status: "review" },
        ship: "ship",
      },
      edges: [
        ["start", "develop"],
        ["develop", "review"],
        ["review", (s) => (s["review.decision"] === "ship" ? "ship" : "develop"), ["ship", "develop"]],
        ["ship", "end"],
      ],
    });
  };

  it("moves the task by its nodes and answers, and refuses other moves", async () => {
    const core = await testCore();
    await withPlugin(core, plugin);
    const task = newTask(core);
    const changes: string[] = [];
    core.events.on("task.status.changed", ({ to }) => changes.push(to));

    core.processes.start(task.id, "flow.dev");
    await core.processes.settled(task.id);
    expect(core.store.task(task.id)!.status).toBe("review");
    expect(() => core.store.setStatus(task.id, "todo")).toThrow(
      "Development moves this task; now it can go to in_progress, ready",
    );

    // The status menu answers the question: "in_progress" is the "back" option.
    core.processes.setStatus(task.id, "in_progress");
    await core.processes.settled(task.id);
    expect(changes).toEqual(["in_progress", "review", "in_progress", "review"]);

    core.processes.setStatus(task.id, "ready");
    expect(core.store.task(task.id)!.status).toBe("ready");
    expect(await core.processes.settled(task.id)).toMatchObject({ state: "done" });
    expect(core.store.task(task.id)!.status).toBe("done");
    expect(changes.slice(4)).toEqual(["ready", "done"]);
    expect(core.processes.owns(task.id)).toBe(false);
  });

  it("names a missing status as a problem", async () => {
    const core = await testCore();
    await withPlugin(core, (ctx) => {
      ctx.steps.register({ id: "s", label: "S", run: () => {} });
      ctx.processes.register({
        id: "w",
        label: "W",
        doneStatus: "shipped",
        nodes: { s: { step: "s", status: "testing" } },
        edges: [["start", "s"], ["s", "end"]],
      });
    });
    expect(core.processes.list()[0]).toMatchObject({
      nodes: [{ id: "s", step: "flow.s", label: "S", status: "testing" }],
      doneStatus: "shipped",
      problems: ["Node s: no status testing", "No status shipped, which the process ends with"],
    });
  });

  it("refuses a status no answer offers while running", async () => {
    const core = await testCore();
    await withPlugin(core, (ctx) => {
      ctx.steps.register({ id: "s", label: "S", run: () => new Promise(() => {}) });
      ctx.processes.register({ id: "w", label: "W", nodes: { s: "s" }, edges: [["start", "s"], ["s", "end"]] });
    });
    const task = newTask(core);
    core.processes.start(task.id, "flow.w");
    expect(() => core.processes.setStatus(task.id, "done")).toThrow("W moves this task; its status follows the process");
  });
});

describe("processes over HTTP", () => {
  it("starts, answers and shows runs in the state", async () => {
    const core = await testCore();
    await withPlugin(core, (ctx) => {
      ctx.steps.register({
        id: "ask",
        label: "Ask",
        run: ({ ask }) => void ask({ kind: "choice", title: "Go?", options: [{ id: "go", label: "Go" }] }),
      });
      ctx.processes.register({ id: "w", label: "W", nodes: { a: "ask" }, edges: [["start", "a"], ["a", "end"]] });
    });
    const task = newTask(core);
    const http = await startHttp(core, { host: "127.0.0.1", port: 0, token: "t", built: true });
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`http://127.0.0.1:${http.port}${path}`, {
        method,
        headers: { authorization: "Bearer t", "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, json: await res.json() };
    };
    try {
      expect((await call("POST", `/api/tasks/${task.id}/process`, { process: "flow.w" })).status).toBe(200);
      await core.processes.settled(task.id);
      const state = (await call("GET", "/api/state")).json;
      expect(state.processes.defs.map((w: any) => w.id)).toEqual(["flow.w"]);
      expect(state.processes.runs[0]).toMatchObject({ taskId: task.id, state: "waiting" });
      expect((await call("POST", `/api/tasks/${task.id}/process/resume`, { answer: "nope" })).status).toBe(400);
      expect((await call("POST", `/api/tasks/${task.id}/process/resume`, { answer: "go" })).status).toBe(200);
      expect(await core.processes.settled(task.id)).toMatchObject({ state: "done" });
    } finally {
      await http.close();
    }
  });
});

describe("processes across restarts", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** A core over a data directory that outlives it, like the app's across restarts. */
  const open = (dataDir: string) => createCore({ root, dataDir, pluginsDir: join(dataDir, "no-plugins") });

  /** The step asks, then returns the body as it is when the answer comes. */
  const plugin = (ctx: PluginContext) => {
    ctx.steps.register({
      id: "ask",
      label: "Ask",
      writes: ["ask.body"],
      run: ({ ask, task }) => {
        ask({ kind: "choice", title: "Go?", options: [{ id: "go", label: "Go" }] });
        return { "ask.body": task.body };
      },
    });
    ctx.steps.register({ id: "hang", label: "Hang", run: () => new Promise(() => {}) });
    ctx.processes.register({ id: "w", label: "W", nodes: { a: "ask" }, edges: [["start", "a"], ["a", "end"]] });
    ctx.processes.register({ id: "h", label: "H", nodes: { h: "hang" }, edges: [["start", "h"], ["h", "end"]] });
  };

  it("resumes a waiting process after a restart, with the body as it is now", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "agent-wf-"));
    dirs.push(dataDir);

    const first = await open(dataDir);
    await withPlugin(first, plugin);
    const task = newTask(first, "first draft");
    first.processes.start(task.id, "flow.w");
    expect(await first.processes.settled(task.id)).toMatchObject({ state: "waiting" });
    const hanging = newTask(first);
    first.processes.start(hanging.id, "flow.h");
    first.close();

    const second = await open(dataDir);
    try {
      await withPlugin(second, plugin);
      // The step that was running when the app stopped did not finish.
      expect(second.processes.run(hanging.id)).toMatchObject({ state: "failed", error: "Stopped when the app restarted" });

      second.store.updateTask(task.id, { body: "edited after the start" });
      second.processes.resume(task.id, "go");
      expect(await second.processes.settled(task.id)).toMatchObject({ state: "done" });
      const values = (await (second.processes as any).graph("flow.w").getState({ configurable: { thread_id: task.id } }))
        .values;
      expect(values.data).toEqual({ "ask.body": "edited after the start" });
    } finally {
      second.close();
    }
  });
});

describe("tasks made by a process", () => {
  const plugin = (ctx: PluginContext) => {
    ctx.steps.register({
      id: "name",
      label: "Name",
      run: async ({ ask, setTask, progress }) => {
        const { title } = ask<{ title: string }>({ kind: "form", title: "Task?", fields: [{ id: "title", label: "Title" }] });
        progress("Naming it");
        setTask({ title, body: `About ${title}` });
      },
    });
    ctx.steps.register({ id: "wait", label: "Wait", run: ({ ask }) => void ask({ kind: "choice", title: "OK?", options: [{ id: "ok", label: "OK" }] }) });
    ctx.processes.register({
      id: "w",
      label: "W",
      icon: "bug",
      hotkey: "Alt+B",
      nodes: { name: "name", wait: "wait" },
      edges: [["start", "name"], ["name", "wait"], ["wait", "end"]],
    });
    ctx.processes.register({ id: "broken", label: "Broken", nodes: { x: "nope" }, edges: [["start", "x"]] });
  };

  it("lists a process's icon and hotkey", async () => {
    const core = await testCore();
    await withPlugin(core, plugin);
    expect(core.processes.list()[0]).toMatchObject({ id: "flow.w", icon: "bug", hotkey: "Alt+B" });
  });

  it("creates the task and starts the process; one that cannot run leaves no task", async () => {
    const core = await testCore();
    await withPlugin(core, plugin);
    const folder = core.store.createFolder({ name: "F" });
    expect(() => core.processes.createTask({ folderId: folder.id, title: "New task" }, "flow.broken")).toThrow(/cannot run/);
    expect(() => core.processes.createTask({ folderId: folder.id, title: "New task" }, "flow.none")).toThrow(/No process/);
    expect(core.store.tasks(folder.id)).toEqual([]);

    const task = core.processes.createTask({ folderId: folder.id, title: "New task" }, "flow.w");
    expect(await core.processes.settled(task.id)).toMatchObject({ state: "waiting", node: "name", progress: null });
  });

  it("lets a step rename the task and report progress, which the next step starts without", async () => {
    const core = await testCore();
    await withPlugin(core, plugin);
    const task = newTask(core);
    const seen: (string | null)[] = [];
    core.events.on("process.updated", (run) => seen.push(run.progress));
    core.processes.start(task.id, "flow.w");
    await core.processes.settled(task.id);
    core.processes.resume(task.id, { title: "Fix login" });
    expect(await core.processes.settled(task.id)).toMatchObject({ state: "waiting", node: "wait", progress: null });
    expect(seen).toContain("Naming it");
    expect(core.store.task(task.id)).toMatchObject({ title: "Fix login", body: "About Fix login" });
  });

  it("creates a folder with its settings, and a task with a process, over HTTP", async () => {
    const core = await testCore();
    await withPlugin(core, plugin);
    const http = await startHttp(core, { host: "127.0.0.1", port: 0, token: "t", built: true });
    const post = (path: string, body: unknown) =>
      fetch(`http://127.0.0.1:${http.port}${path}`, {
        method: "POST",
        headers: { authorization: "Bearer t", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    try {
      const bad = await post("/api/folders", { name: "A", settings: { taskProcesses: [{ process: "flow.w" }, { process: "flow.w" }] } });
      expect(bad.status).toBe(400);
      expect((await bad.json()).error).toMatch(/listed twice/);
      expect(core.store.folders()).toEqual([]);

      const res = await post("/api/folders", { name: "A", settings: { taskProcesses: [{ process: "flow.w", hotkey: "" }] } });
      const folder = await res.json();
      expect(folder.settings).toEqual({ taskProcesses: [{ process: "flow.w", hotkey: "" }] });
      expect(core.settings.get("taskProcesses", folder.id)).toEqual([{ process: "flow.w", hotkey: "" }]);

      const task = await (await post("/api/tasks", { folderId: folder.id, title: "New task", process: "flow.w" })).json();
      expect(await core.processes.settled(task.id)).toMatchObject({ process: "flow.w", state: "waiting" });
    } finally {
      await http.close();
    }
  });

  it("resumes another task's process from inside a step, as a plugin's event handler does", async () => {
    const core = await testCore();
    const ctx = await withPlugin(core, (ctx) => {
      ctx.steps.register({ id: "wait", label: "Wait", run: ({ ask }) => void ask({ kind: "choice", title: "Go?", options: [{ id: "go", label: "Go" }] }) });
      ctx.steps.register({
        id: "wake",
        label: "Wake the other",
        run: async () => {
          const other = ctx.tasks.list().find((t) => t.title === "waiting")!;
          ctx.processes.resume(other.id, "go");
        },
      });
      for (const step of ["wait", "wake"]) {
        ctx.processes.register({ id: step, label: step, nodes: { n: step }, edges: [["start", "n"], ["n", "end"]] });
      }
    });
    const waiting = newTask(core);
    core.store.updateTask(waiting.id, { title: "waiting" });
    ctx.processes.start(waiting.id, "flow.wait");
    expect(await core.processes.settled(waiting.id)).toMatchObject({ state: "waiting" });
    const waker = newTask(core);
    core.processes.start(waker.id, "flow.wake");
    expect(await core.processes.settled(waker.id)).toMatchObject({ state: "done" });
    expect(await core.processes.settled(waiting.id)).toMatchObject({ state: "done" });
  });
});
