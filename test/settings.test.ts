import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { definePlugin } from "../src/sdk/server.ts";
import { envName } from "../src/server/settings.ts";
import { startHttp } from "../src/server/http.ts";
import { fakeProvider, testCore } from "./helpers.ts";

const settingsFile = () => join(mkdtempSync(join(tmpdir(), "agent-settings-")), "settings.json");

/** A core with one plugin, "flow", that defines a folder setting and an app setting. */
async function coreWith(sources: { file?: string; env?: Record<string, string>; cli?: Record<string, string> } = {}) {
  const file = sources.file ?? settingsFile();
  const core = await testCore({ settings: { ...sources, file } });
  let ctx: any;
  await core.plugins.load(
    "flow",
    {},
    definePlugin((c) => {
      ctx = c;
      c.settings.define([
        { key: "targetBranch", label: "Target branch", type: "string", default: "main", folder: true },
        { key: "loops", label: "Fix loops", type: "number", default: 3 },
      ]);
    }),
  );
  return { core, ctx, file };
}

describe("settings", () => {
  it("names environment variables after the key", () => {
    expect(envName("defaultProvider")).toBe("PITWALL_DEFAULT_PROVIDER");
    expect(envName("dev-flow.targetBranch")).toBe("PITWALL_DEV_FLOW_TARGET_BRANCH");
  });

  it("prefixes a plugin's keys with its id and lets it read them without", async () => {
    const { core, ctx } = await coreWith();
    const keys = core.settings.defs().map((d) => d.key);
    expect(keys).toContain("defaultProvider");
    expect(keys.filter((k) => k.startsWith("flow."))).toEqual(["flow.targetBranch", "flow.loops"]);
    expect(ctx.settings.get("loops")).toBe(3);
    expect(ctx.settings.get("flow.loops")).toBe(3);
  });

  it("takes the command line over the environment over the file over the default", async () => {
    const file = settingsFile();
    writeFileSync(file, JSON.stringify({ "flow.loops": 5, "flow.targetBranch": "dev" }));
    const { core } = await coreWith({
      file,
      env: { PITWALL_FLOW_LOOPS: "7", PITWALL_DEFAULT_PROVIDER: "" },
      cli: { "flow.targetBranch": "release" },
    });
    expect(core.settings.app("flow.targetBranch")).toEqual({ value: "release", source: "cli" });
    expect(core.settings.app("flow.loops")).toEqual({ value: 7, source: "env" });
    expect(core.settings.app("defaultProvider")).toEqual({ value: "claude-code", source: "default" });
  });

  it("writes app values to the file and refuses ones the command line or environment set", async () => {
    const { core, file } = await coreWith({ env: { PITWALL_FLOW_LOOPS: "7" } });
    core.settings.set("flow.targetBranch", "dev");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ "flow.targetBranch": "dev" });
    expect(core.settings.app("flow.targetBranch")).toEqual({ value: "dev", source: "file" });
    expect(() => core.settings.set("flow.loops", 1)).toThrow(/PITWALL_FLOW_LOOPS/);
    expect(() => core.settings.set("flow.targetBranch", 1)).toThrow(/expected a string/);
    core.settings.set("flow.targetBranch", null);
    expect(core.settings.app("flow.targetBranch").source).toBe("default");
  });

  it("rereads the file when it is edited by hand", async () => {
    const { core, file } = await coreWith();
    core.settings.set("flow.loops", 4);
    writeFileSync(file, JSON.stringify({ "flow.loops": 9 }));
    // Same-millisecond writes keep the mtime; push it forward to stand for a later edit.
    const { utimesSync } = await import("node:fs");
    utimesSync(file, new Date(), new Date(Date.now() + 5000));
    expect(core.settings.get("flow.loops")).toBe(9);
  });

  it("lets folders override folder settings, and subfolders inherit", async () => {
    const { core } = await coreWith();
    const top = core.store.createFolder({ name: "Top" });
    const sub = core.store.createFolder({ name: "Sub", parentId: top.id });
    expect(core.settings.get("flow.targetBranch", sub.id)).toBe("main");

    core.settings.setFolder(top.id, "flow.targetBranch", "dev");
    expect(core.settings.get("flow.targetBranch", sub.id)).toBe("dev");
    expect(core.settings.inherited("flow.targetBranch", sub.id)).toMatchObject({ value: "dev", from: { id: top.id } });

    core.settings.setFolder(sub.id, "flow.targetBranch", "feature");
    expect(core.settings.get("flow.targetBranch", sub.id)).toBe("feature");
    expect(core.settings.get("flow.targetBranch", top.id)).toBe("dev");

    core.settings.setFolder(sub.id, "flow.targetBranch", null);
    expect(core.store.folder(sub.id)!.settings).toEqual({});
    expect(() => core.settings.setFolder(top.id, "flow.loops", 2)).toThrow(/app setting/);
  });

  it("starts the folder's default agent", async () => {
    const { core } = await coreWith();
    await core.plugins.load(
      "agents",
      { permissions: { "agents:provide": "test" } },
      definePlugin((ctx) => {
        ctx.agents.registerProvider({ ...fakeProvider("exit 0"), id: "one" });
        ctx.agents.registerProvider({ ...fakeProvider("exit 0"), id: "two" });
      }),
    );
    const folder = core.store.createFolder({ name: "F" });
    const task = core.store.createTask({ folderId: folder.id, title: "T" });
    // "claude-code", the default, is not installed here: the first agent there is.
    expect(core.sessions.start(task.id).provider).toBe("one");
    core.settings.setFolder(folder.id, "defaultProvider", "two");
    expect(core.sessions.start(task.id).provider).toBe("two");
    expect(core.state().settings.defs.find((d) => d.key === "defaultProvider")!.options).toEqual([
      { value: "one", label: "Fake agent" },
      { value: "two", label: "Fake agent" },
    ]);
  });

  it("changes settings over HTTP", async () => {
    const { core } = await coreWith();
    const http = await startHttp(core, { host: "127.0.0.1", port: 0, token: "t", built: true });
    const put = (path: string, value: unknown) =>
      fetch(`http://127.0.0.1:${http.port}${path}`, {
        method: "PUT",
        headers: { authorization: "Bearer t", "content-type": "application/json" },
        body: JSON.stringify({ value }),
      });
    try {
      expect((await put(`/api/settings/${encodeURIComponent("flow.loops")}`, 2)).status).toBe(200);
      expect(core.settings.get("flow.loops")).toBe(2);
      const folder = core.store.createFolder({ name: "F" });
      expect((await put(`/api/folders/${folder.id}/settings/flow.targetBranch`, "dev")).status).toBe(200);
      expect(core.settings.get("flow.targetBranch", folder.id)).toBe("dev");
      const bad = await put("/api/settings/nope", 1);
      expect(bad.status).toBe(400);
      expect((await bad.json()).error).toMatch(/No setting nope/);
    } finally {
      await http.close();
    }
  });

  it("checks a folder's task buttons", async () => {
    const core = await testCore();
    const folder = core.store.createFolder({ name: "F" });
    const set = (value: unknown) => core.settings.setFolder(folder.id, "taskProcesses", value);
    expect(() => set({ process: "a" })).toThrow(/list of processes/);
    expect(() => set([{ icon: "bug" }])).toThrow(/"process" id/);
    expect(() => set([{ process: "a", hotkey: 1 }])).toThrow(/"hotkey" must be text/);
    expect(() => set([{ process: "a", color: "red" }])).toThrow(/unknown color/);
    expect(set([{ process: "a", icon: "bug" }, { process: "b", hotkey: "" }]).settings.taskProcesses).toHaveLength(2);
    expect(core.settings.get("taskProcesses")).toEqual([]);
  });
});
