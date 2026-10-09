import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { definePlugin } from "../../../src/sdk/server.ts";
import { fakeProvider, root, testCore, waitFor } from "../../../test/helpers.ts";

async function setup() {
  const core = await testCore({
    pluginsDir: join(root, "plugins"),
    defaultProvider: "fake",
  });
  await core.plugins.load(
    "fake-agent",
    { permissions: { "agents:provide": "" } },
    definePlugin((ctx) => ctx.agents.registerProvider(fakeProvider('printf "%s" "$1"; sleep 5'))),
  );
  const folder = core.store.createFolder({ name: "F" });
  const create = (process: string) => core.processes.createTask({ folderId: folder.id, title: "New task" }, process);
  return { core, create };
}

describe("example-flow", () => {
  it("registers two processes that can run, with icons and the note's hotkey", async () => {
    const { core } = await setup();
    const defs = core.processes.list().filter((w) => w.plugin === "example-flow");
    expect(defs.map((w) => [w.id, w.icon, w.hotkey, w.problems])).toEqual([
      ["example-flow.agent", "bot", undefined, []],
      ["example-flow.note", "notebook-pen", "Alt+N", []],
    ]);
  });

  it("Agent task: the form names the task, the folder's agent gets it as its prompt, Done ends it", async () => {
    const { core, create } = await setup();
    const task = create("example-flow.agent");
    expect(await core.processes.settled(task.id)).toMatchObject({ state: "waiting", node: "describe" });
    core.processes.resume(task.id, { title: " Write docs ", body: "For the API " });
    const run = await core.processes.settled(task.id);
    expect(run).toMatchObject({ state: "waiting", node: "review" });
    expect(core.store.task(task.id)).toMatchObject({ title: "Write docs", body: "For the API", status: "in_progress" });
    expect(run?.request?.kind === "choice" && run.request.options.map((o) => o.id)).toEqual(["done"]);
    const [session] = core.sessions.list(task.id);
    await waitFor(() => core.sessions.scrollback(session.id).includes("For the API"));
    expect(core.sessions.scrollback(session.id)).toContain("Write docs");

    core.processes.resume(task.id, "done");
    expect(await core.processes.settled(task.id)).toMatchObject({ state: "done" });
    expect(core.store.task(task.id)?.status).toBe("done");
  });

  it("Quick note: no form, named at once, stays To do", async () => {
    const { core, create } = await setup();
    const task = create("example-flow.note");
    expect(await core.processes.settled(task.id)).toMatchObject({ state: "done" });
    expect(core.store.task(task.id)).toMatchObject({ status: "todo" });
    expect(core.store.task(task.id)?.title).toMatch(/^Note \d{4}-\d\d-\d\d \d\d:\d\d$/);
  });
});
