import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { definePlugin, type PluginContext, type ProcessSpec } from "../../../src/sdk/server.ts";
import { createCore, type Core } from "../../../src/server/app.ts";
import { root } from "../../../test/helpers.ts";
import editor from "../server.ts";
import { diffSpecs, qualify, setCase, setNode, setParam } from "../specs.ts";

const all = { "steps:register": "", "processes:register": "", "processes:run": "", "tasks:write": "", "agents:spawn": "" };
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

const loop: ProcessSpec = {
  id: "loop",
  label: "Loop",
  nodes: { ask: "steps.ask", test: { step: "steps.test", status: "in_progress" }, fix: "steps.fix" },
  edges: [
    ["start", "ask"],
    ["ask", "test"],
    ["test", { on: "tests.passed", cases: { true: "end" }, else: "fix" }],
    ["fix", "test"],
  ],
};

function steps(ctx: PluginContext) {
  ctx.steps.register({
    id: "test",
    label: "Tests",
    writes: ["tests.passed"],
    params: { command: { type: "string", label: "Command", default: "npm test" } },
    run: () => ({ "tests.passed": true }),
  });
  ctx.steps.register({ id: "fix", label: "Fix", run: () => {} });
  ctx.steps.register({
    id: "ask",
    label: "Ask",
    run: ({ ask }) => void ask({ kind: "choice", title: "Go?", options: [{ id: "go", label: "Go" }] }),
  });
}

async function setup() {
  const base = mkdtempSync(join(tmpdir(), "agent-editor-"));
  const pluginsDir = join(base, "plugins");
  mkdirSync(join(pluginsDir, "flows", "processes"), { recursive: true });
  writeFileSync(join(pluginsDir, "flows", "plugin.json"), "{}");
  writeFileSync(join(pluginsDir, "flows", "processes", "loop.json"), JSON.stringify(loop));
  const core: Core = await createCore({ root, dataDir: join(base, "data"), pluginsDir });
  cleanups.push(() => {
    core.close();
    rmSync(base, { recursive: true, force: true });
  });
  await core.plugins.load("steps", { permissions: all }, definePlugin(steps));
  core.processes.loadFiles(pluginsDir, ["flows", "steps"]);
  const loaded = await core.plugins.load("process-editor", { permissions: all }, editor);
  const call = <T,>(name: string, input: unknown) => loaded.rpc.get(name)!(input) as T;
  return { core, call, pluginsDir };
}

describe("specs", () => {
  it("changes a node, a parameter and a way on, and counts what changed", () => {
    let spec = setNode(loop, "fix", { label: "Fix it", skip: true });
    spec = setParam(spec, "test", "command", "pnpm test");
    spec = setCase(spec, "test", "true", "fix");
    expect(spec.nodes.fix).toEqual({ step: "steps.fix", label: "Fix it", skip: true });
    expect(spec.nodes.test).toEqual({ step: "steps.test", status: "in_progress", params: { command: "pnpm test" } });
    expect(setParam(spec, "test", "command", undefined).nodes.test).toEqual({ step: "steps.test", status: "in_progress" });
    expect(setNode(spec, "fix", { label: null, skip: null }).nodes.fix).toBe("steps.fix");
    expect(diffSpecs(loop, spec)).toMatchObject({ added: [], removed: [], changed: ["test", "fix"], count: 2 });
  });

  it("writes a code process's own steps with its plugin's prefix", () => {
    const spec = qualify({ ...loop, nodes: { a: "describe", b: { step: "steps.fix" } } }, "dev-flow", [
      { id: "dev-flow.describe" } as never,
      { id: "steps.fix" } as never,
    ]);
    expect(spec.nodes).toEqual({ a: "dev-flow.describe", b: "steps.fix" });
  });
});

describe("the editor's server part", () => {
  it("keeps a draft and previews it with its problems", async () => {
    const { call } = await setup();
    const broken = setCase(loop, "test", "true", "nowhere");
    const info = call<{ issues: { code: string }[] }>("saveDraft", { id: "flows.loop", spec: broken });
    expect(info.issues.map((i) => i.code)).toContain("noEdge");
    expect(call<{ spec: ProcessSpec }>("draft", { id: "flows.loop" }).spec).toEqual(broken);
    call("dropDraft", { id: "flows.loop" });
    expect(call("draft", { id: "flows.loop" })).toBeNull();
  });

  it("applies a change to a plugin's process as the user's own version, and brings the original back", async () => {
    const { core, call, pluginsDir } = await setup();
    const changed = setParam(loop, "test", "command", "pnpm test");
    expect(call("apply", { id: "flows.loop", spec: changed, note: "pnpm" })).toBe("flows.loop");
    const file = join(pluginsDir, "my-processes", "processes", "flows-loop.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ id: "flows-loop", overrides: "flows.loop" });
    // The plugin's own file is untouched.
    expect(JSON.parse(readFileSync(join(pluginsDir, "flows", "processes", "loop.json"), "utf8"))).toEqual(loop);
    const mine = core.processes.get("flows.loop")!;
    expect(mine).toMatchObject({ plugin: "my-processes", original: { plugin: "flows", updated: false } });

    // Changing it again rewrites the same file.
    call("apply", { id: "flows.loop", spec: setNode(mine.spec, "fix", { label: "Fix it" }), note: "name" });
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ overrides: "flows.loop", nodes: { fix: { label: "Fix it" } } });
    expect(core.processes.versions("flows.loop").map((v) => v.note)).toEqual(["name", "pnpm", null]);

    call("revert", { id: "flows.loop" });
    expect(existsSync(file)).toBe(false);
    expect(core.processes.get("flows.loop")).toMatchObject({ plugin: "flows", label: "Loop" });
  });

  it("moves a waiting task to the new version when its step is still there", async () => {
    const { core, call } = await setup();
    const folder = core.store.createFolder({ name: "F" });
    const task = core.processes.createTask({ folderId: folder.id, title: "T" }, "flows.loop");
    expect(await core.processes.settled(task.id)).toMatchObject({ state: "waiting", node: "ask" });
    const before = core.processes.run(task.id)!.version;
    call("apply", { id: "flows.loop", spec: setNode(loop, "fix", { label: "Fix it" }) });
    expect(call<{ version: string }>("upgrade", { taskId: task.id }).version).not.toBe(before);
    expect(core.processes.run(task.id)!.version).toBe(core.processes.get("flows.loop")!.version);
  });

  it("creates the user's own process with a free id", async () => {
    const { core, call } = await setup();
    const first = call<string>("create", { spec: { id: "process", label: "Статьи", nodes: {}, edges: [["start", "end"]] } });
    const second = call<string>("create", { spec: { id: "process", label: "Статьи", nodes: {}, edges: [["start", "end"]] } });
    expect([first, second]).toEqual(["my-processes.process", "my-processes.process-2"]);
    expect(core.processes.get(first)).toMatchObject({ label: "Статьи", problems: [] });
    call("removeProcess", { id: second });
    expect(core.processes.get(second)).toBeUndefined();
  });

  it("tries a draft on a task out of the tree, lists the trials and forgets old ones", async () => {
    const { core, call } = await setup();
    const folder = core.store.createFolder({ name: "F" });
    const draft = setNode(loop, "ask", { skip: true });
    const task = call<{ id: string; meta: Record<string, unknown> }>("trial", {
      id: "flows.loop",
      spec: draft,
      folderId: folder.id,
      title: "Try",
      dryRun: true,
      stepByStep: false,
    });
    expect(task.meta).toMatchObject({ trial: true, "process-editor": { trial: "flows.loop", draft: true } });
    expect(await core.processes.settled(task.id)).toMatchObject({ state: "done", options: { trial: true, dryRun: true } });
    expect(call<{ id: string }[]>("trials", { id: "flows.loop" }).map((x) => x.id)).toEqual([task.id]);
    // The installed process is as it was.
    expect(core.processes.get("flows.loop")?.spec).toEqual(loop);

    call("keepTrial", { taskId: task.id, keep: true });
    core.db.prepare("UPDATE tasks SET created_at = ? WHERE id = ?").run(Date.now() - 2 * 24 * 3600_000, task.id);
    call("sweepTrials", {});
    expect(core.store.task(task.id)).toBeDefined();
    call("keepTrial", { taskId: task.id, keep: false });
    call("sweepTrials", {});
    expect(core.store.task(task.id)).toBeUndefined();
  });
});
