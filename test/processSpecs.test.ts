import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { definePlugin, type PluginContext } from "../src/sdk/server.ts";
import { createCore, type Core } from "../src/server/app.ts";
import type { ProcessSpec } from "../src/sdk/types.ts";
import { root } from "./helpers.ts";

const permissions = {
  "statuses:register": "test",
  "steps:register": "test",
  "processes:register": "test",
  "processes:run": "test",
};

const dirs: string[] = [];
const cores: Core[] = [];
afterEach(() => {
  for (const core of cores.splice(0)) core.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A plugins directory with the given process files, and a data directory. */
function dirsWith(files: Record<string, ProcessSpec> = {}) {
  const base = mkdtempSync(join(tmpdir(), "agent-specs-"));
  dirs.push(base);
  const pluginsDir = join(base, "plugins");
  const dataDir = join(base, "data");
  for (const [path, spec] of Object.entries(files)) {
    const [plugin, name] = path.split("/");
    mkdirSync(join(pluginsDir, plugin, "processes"), { recursive: true });
    writeFileSync(join(pluginsDir, plugin, "plugin.json"), JSON.stringify({ permissions }));
    writeFileSync(join(pluginsDir, plugin, "processes", `${name}.json`), JSON.stringify(spec));
  }
  mkdirSync(pluginsDir, { recursive: true });
  return { pluginsDir, dataDir };
}

/** A core whose plugin "steps" registers steps; the plugins directory holds process files. */
async function core(
  steps: (ctx: PluginContext) => void,
  files: Record<string, ProcessSpec> = {},
  where = dirsWith(files),
): Promise<Core> {
  const c = await createCore({ root, ...where });
  cores.push(c);
  await c.plugins.load("steps", { permissions }, definePlugin(steps));
  // Files load after the steps they use, as at start.
  c.processes.loadFiles(where.pluginsDir, ["flows", "my-processes", "steps"]);
  return c;
}

const newTask = (c: Core) => c.store.createTask({ folderId: c.store.createFolder({ name: "F" }).id, title: "T" });

/** Steps: "test" passes when told to, "fix" counts, "ask" asks yes or no. */
function basicSteps(log: string[], passes: () => boolean = () => true) {
  return (ctx: PluginContext) => {
    ctx.steps.register({
      id: "test",
      label: "Tests",
      writes: ["tests.passed"],
      outcomes: { "tests.passed": { true: "passed", false: "failed" } },
      params: { command: { type: "string", label: "Command", default: { setting: "steps.cmd" } } },
      run: ({ params }) => {
        log.push(`test ${params.command}`);
        return { "tests.passed": passes() };
      },
    });
    ctx.steps.register({ id: "fix", label: "Fix", role: "agent", run: () => void log.push("fix") });
    ctx.steps.register({
      id: "ask",
      label: "Ask",
      writes: ["choice.answer"],
      questions: [{ id: "ok", kind: "choice", title: "OK?", options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] }],
      run: ({ ask }) => ({
        "choice.answer": ask({ kind: "choice", id: "ok", title: "OK?", options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] }),
      }),
    });
    ctx.steps.register({ id: "push", label: "Push", sideEffects: true, run: () => void log.push("push") });
    ctx.settings.define([{ key: "cmd", label: "Command", type: "string", default: "npm test", folder: true }]);
  };
}

const loop: ProcessSpec = {
  id: "loop",
  label: "Loop",
  nodes: { test: "steps.test", fix: "steps.fix" },
  edges: [
    ["start", "test"],
    ["test", { on: "tests.passed", cases: { true: "end", false: "fix" } }],
    ["fix", "test"],
  ],
};

describe("processes as files", () => {
  it("loads a process file and branches on a key with a switch", async () => {
    const log: string[] = [];
    let n = 0;
    const c = await core(basicSteps(log, () => ++n > 1), { "flows/loop": loop });
    const info = c.processes.list().find((w) => w.id === "flows.loop")!;
    expect(info).toMatchObject({ source: "file", editable: true, problems: [], asks: 0 });
    expect(info.version).toMatch(/^[0-9a-f]{12}$/);
    const task = newTask(c);
    c.processes.start(task.id, "flows.loop");
    expect(await c.processes.settled(task.id)).toMatchObject({ state: "done" });
    expect(log).toEqual(["test npm test", "fix", "test npm test"]);
    expect(c.processes.trace(task.id).map((e) => [e.node, e.result, e.output])).toEqual([
      ["test", "done", { "tests.passed": false }],
      ["fix", "done", {}],
      ["test", "done", { "tests.passed": true }],
    ]);
  });

  it("reads a parameter's default from the folder's setting", async () => {
    const log: string[] = [];
    const c = await core(basicSteps(log), { "flows/loop": loop });
    const folder = c.store.createFolder({ name: "F" });
    c.settings.setFolder(folder.id, "steps.cmd", "pnpm test:ci");
    const task = c.store.createTask({ folderId: folder.id, title: "T" });
    c.processes.start(task.id, "flows.loop");
    await c.processes.settled(task.id);
    expect(log).toEqual(["test pnpm test:ci"]);
  });

  it("words what is wrong: unreachable nodes, no way to the end, a key nobody writes", async () => {
    const c = await core(basicSteps([]), {
      "flows/bad": {
        id: "bad",
        label: "Bad",
        nodes: { fix: "steps.fix", lonely: "steps.fix", spin: "steps.fix", merge: { step: "steps.test", params: {} } },
        edges: [
          ["start", "fix"],
          ["fix", "spin"],
          ["spin", "fix"],
          ["merge", "end"],
        ],
      },
    });
    const info = c.processes.list().find((w) => w.id === "flows.bad")!;
    expect(info.issues.map((i) => [i.code, i.node])).toEqual([
      ["noExit", "fix"],
      ["unreachable", "lonely"],
      ["noExit", "spin"],
      ["unreachable", "merge"],
    ]);
  });

  it("saves a user's own version in place of a plugin's, and removes it to bring the original back", async () => {
    const log: string[] = [];
    const where = dirsWith({ "flows/loop": loop });
    const c = await core(basicSteps(log), {}, where);
    const original = c.processes.list().find((w) => w.id === "flows.loop")!;
    const mine: ProcessSpec = { ...loop, id: "loop", label: "My loop", overrides: "flows.loop", base: original.version! };
    expect(c.processes.save("my-processes", mine, "rename it")).toBe("flows.loop");
    const file = join(where.pluginsDir, "my-processes", "processes", "loop.json");
    expect(JSON.parse(readFileSync(file, "utf8")).label).toBe("My loop");
    expect(JSON.parse(readFileSync(join(where.pluginsDir, "my-processes", "plugin.json"), "utf8")).name).toBe("My processes");
    const info = c.processes.list().find((w) => w.id === "flows.loop")!;
    expect(info).toMatchObject({ label: "My loop", plugin: "my-processes", original: { plugin: "flows", updated: false } });
    expect(c.processes.list().filter((w) => w.id.endsWith(".loop"))).toHaveLength(1);
    expect(c.processes.versions("flows.loop").map((v) => [v.spec.label, v.note])).toEqual([
      ["My loop", "rename it"],
      ["Loop", null],
    ]);
    c.processes.remove("flows.loop");
    expect(c.processes.list().find((w) => w.id === "flows.loop")).toMatchObject({ label: "Loop", plugin: "flows" });
  });

  it("keeps a waiting task on the version it started with", async () => {
    const log: string[] = [];
    const ask: ProcessSpec = {
      id: "ask",
      label: "Ask",
      nodes: { ask: "steps.ask", fix: "steps.fix" },
      edges: [
        ["start", "ask"],
        ["ask", "fix"],
        ["fix", "end"],
      ],
    };
    const c = await core(basicSteps(log), { "flows/ask": ask });
    const task = newTask(c);
    c.processes.start(task.id, "flows.ask");
    expect(await c.processes.settled(task.id)).toMatchObject({ state: "waiting", node: "ask" });
    // The fix step is gone from the new version: the waiting task does not notice.
    c.processes.save("flows", { ...ask, nodes: { ask: "steps.ask" }, edges: [["start", "ask"], ["ask", "end"]] });
    c.processes.resume(task.id, "yes");
    expect(await c.processes.settled(task.id)).toMatchObject({ state: "done" });
    expect(log).toEqual(["fix"]);
    expect(c.processes.trace(task.id).map((e) => [e.node, e.result, e.answer])).toEqual([
      ["ask", "done", "yes"],
      ["fix", "done", null],
    ]);
  });

  it("runs a draft as a trial without consequences, out of the tree's way", async () => {
    const log: string[] = [];
    const c = await core(basicSteps(log), { "flows/loop": loop });
    const folder = c.store.createFolder({ name: "F" });
    const draft: ProcessSpec = { ...loop, nodes: { push: "steps.push", test: "steps.test" }, edges: [["start", "push"], ["push", "test"], ["test", "end"]] };
    const task = c.processes.createTask({ folderId: folder.id, title: "Trial" }, "flows.loop", {}, { trial: true, dryRun: true }, draft);
    expect(task.meta.trial).toBe(true);
    expect(await c.processes.settled(task.id)).toMatchObject({ state: "done", options: { trial: true, dryRun: true } });
    expect(log).toEqual(["test npm test"]);
    expect(c.processes.trace(task.id).map((e) => [e.node, e.result])).toEqual([
      ["push", "skipped"],
      ["test", "done"],
    ]);
    // The installed process did not change.
    expect(c.processes.list().find((w) => w.id === "flows.loop")?.nodes.map((n) => n.id)).toEqual(["test", "fix"]);
  });

  it("asks before each step of a step-by-step trial", async () => {
    const log: string[] = [];
    const c = await core(basicSteps(log), { "flows/loop": loop });
    const folder = c.store.createFolder({ name: "F" });
    const task = c.processes.createTask({ folderId: folder.id, title: "Trial" }, "flows.loop", {}, { trial: true, stepByStep: true });
    expect(await c.processes.settled(task.id)).toMatchObject({ state: "waiting", request: { id: "__step", title: "Tests" } });
    c.processes.resume(task.id, "run");
    expect(await c.processes.settled(task.id)).toMatchObject({ state: "done" });
    expect(log).toEqual(["test npm test"]);
  });
});

describe("processes inside processes", () => {
  const inner: ProcessSpec = {
    id: "inner",
    label: "Inner",
    inputs: { "inner.in": { type: "string", label: "In" } },
    outputs: ["choice.answer"],
    nodes: { ask: { step: "steps.ask", status: "in_progress" }, fix: "steps.fix" },
    edges: [
      ["start", "ask"],
      ["ask", "fix"],
      ["fix", "end"],
    ],
  };
  const outer: ProcessSpec = {
    id: "outer",
    label: "Outer",
    nodes: { first: "steps.test", sub: { process: "flows.inner", in: { "inner.in": "tests.passed" }, out: { "choice.answer": "outer.answer" } }, last: "steps.read" },
    edges: [
      ["start", "first"],
      ["first", "sub"],
      ["sub", "last"],
      ["last", "end"],
    ],
  };

  it("runs the inner process as a node: its questions, its statuses, only its outputs back", async () => {
    const log: string[] = [];
    const seen: unknown[] = [];
    const steps = (ctx: PluginContext) => {
      basicSteps(log)(ctx);
      ctx.steps.register({
        id: "read",
        label: "Read",
        reads: ["outer.answer", "choice.answer?", "tests.passed"],
        run: ({ state }) => void seen.push(state),
      });
    };
    const c = await core(steps, { "flows/inner": inner, "flows/outer": outer });
    const info = c.processes.list().find((w) => w.id === "flows.outer")!;
    expect(info.problems).toEqual([]);
    expect(info.asks).toBe(1);
    expect(info.nodes.find((n) => n.id === "sub")).toMatchObject({ process: "flows.inner", role: "you", label: "Inner" });
    const task = newTask(c);
    c.processes.start(task.id, "flows.outer");
    expect(await c.processes.settled(task.id)).toMatchObject({ state: "waiting", node: "sub/ask", path: ["sub", "ask"] });
    expect(c.store.task(task.id)?.status).toBe("in_progress");
    c.processes.resume(task.id, "no");
    expect(await c.processes.settled(task.id)).toMatchObject({ state: "done" });
    expect(seen).toEqual([{ "outer.answer": "no", "tests.passed": true }]);
    expect(c.processes.trace(task.id).map((e) => e.node)).toEqual(["first", "sub/ask", "sub/fix", "last"]);
  });

  it("resumes the inner process's question after a restart", async () => {
    const where = dirsWith({ "flows/inner": inner, "flows/outer": { ...outer, nodes: { ...outer.nodes, last: "steps.fix" } } });
    const log: string[] = [];
    const first = await core(basicSteps(log), {}, where);
    const task = newTask(first);
    first.processes.start(task.id, "flows.outer");
    await first.processes.settled(task.id);
    first.close();
    cores.splice(cores.indexOf(first), 1);

    const again = await core(basicSteps(log), {}, where);
    expect(again.processes.run(task.id)).toMatchObject({ state: "waiting", node: "sub/ask" });
    again.processes.resume(task.id, "yes");
    expect(await again.processes.settled(task.id)).toMatchObject({ state: "done" });
    expect(log).toEqual(["test npm test", "fix", "fix"]);
  });

  it("refuses a process that runs itself", async () => {
    const self: ProcessSpec = { id: "self", label: "Self", nodes: { me: { process: "flows.self" } }, edges: [["start", "me"], ["me", "end"]] };
    const c = await core(basicSteps([]), { "flows/self": self });
    expect(c.processes.list().find((w) => w.id === "flows.self")?.issues.map((i) => i.code)).toEqual(["selfCall"]);
  });
});

describe("answers for the user", () => {
  it("answers a question with autoAnswer and records it", async () => {
    const log: string[] = [];
    const c = await core(basicSteps(log), {
      "flows/ask": { id: "ask", label: "Ask", nodes: { ask: "steps.ask", fix: "steps.fix" }, edges: [["start", "ask"], ["ask", "fix"], ["fix", "end"]] },
    });
    const answered: unknown[] = [];
    c.events.on("process.answered", (e) => answered.push([e.question, e.answer, e.automatic]));
    c.processes.autoAnswer = (_task, run, request) => (run.node === "ask" && request.id === "ok" ? "yes" : undefined);
    const task = newTask(c);
    c.processes.start(task.id, "flows.ask");
    await new Promise((r) => setTimeout(r, 50));
    expect(await c.processes.settled(task.id)).toMatchObject({ state: "done" });
    expect(answered).toEqual([["ok", "yes", true]]);
  });
});
