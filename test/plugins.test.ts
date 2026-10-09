import { describe, expect, it } from "vitest";
import { definePlugin } from "../src/sdk/server.ts";
import { fakeProvider, testCore, waitFor } from "./helpers.ts";

describe("plugins", () => {
  it("records writes and raises an alarm for undeclared permissions", async () => {
    const core = await testCore();
    const alarms: unknown[] = [];
    core.events.on("audit.alarm", (p) => alarms.push(p));

    await core.plugins.load(
      "sneaky",
      { permissions: { "folders:write": "creates its folder" } },
      definePlugin((ctx) => {
        const folder = ctx.folders.create({ name: "Mine" });
        ctx.tasks.create({ folderId: folder.id, title: "Undeclared" });
      }),
    );

    expect(core.store.tasks()).toHaveLength(1); // trust: the write went through
    expect(alarms).toEqual([{ plugin: "sneaky", action: "tasks.create", permission: "tasks:write" }]);
    expect(core.plugins.audit().map((a) => [a.action, a.declared])).toEqual([
      ["tasks.create", false],
      ["folders.create", true],
    ]);
  });

  it("keeps each plugin's key-value data apart", async () => {
    const core = await testCore();
    let a: any, b: any;
    await core.plugins.load("a", {}, definePlugin((ctx) => void (a = ctx)));
    await core.plugins.load("b", {}, definePlugin((ctx) => void (b = ctx)));
    a.kv.set("k", { n: 1 });
    expect(a.kv.get("k")).toEqual({ n: 1 });
    expect(b.kv.get("k")).toBeUndefined();
  });

  it("starts agents in the directory a resolver picks", async () => {
    const core = await testCore({ defaultProvider: "fake" });
    await core.plugins.load(
      "test",
      { permissions: { "agents:provide": "", "workspaces:resolve": "" } },
      definePlugin((ctx) => {
        ctx.agents.registerProvider(fakeProvider("pwd"));
        ctx.workspaces.registerResolver(() => core.app.root);
      }),
    );
    const task = core.store.createTask({ folderId: core.store.createFolder({ name: "A" }).id, title: "T" });
    const session = core.sessions.start(task.id);
    expect(session.cwd).toBe(core.app.root);
    await waitFor(() => core.sessions.get(session.id)?.state === "exited");
    expect(core.sessions.scrollback(session.id)).toContain(core.app.root);
  });

  it("explains a missing agent CLI", async () => {
    const core = await testCore();
    await core.plugins.load(
      "test",
      { permissions: { "agents:provide": "" } },
      definePlugin((ctx) => ctx.agents.registerProvider({ id: "x", label: "X", command: "no-such-agent-cli" })),
    );
    const task = core.store.createTask({ folderId: core.store.createFolder({ name: "A" }).id, title: "T" });
    expect(() => core.sessions.start(task.id)).toThrow(/X is not installed/);
  });
});
