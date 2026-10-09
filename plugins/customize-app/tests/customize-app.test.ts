import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { definePlugin } from "../../../src/sdk/server.ts";
import { fakeProvider, root, testCore, waitFor } from "../../../test/helpers.ts";

async function setup() {
  const core = await testCore({ pluginsDir: join(root, "plugins"), defaultProvider: "fake" });
  await core.plugins.load(
    "fake-agent",
    { permissions: { "agents:provide": "" } },
    definePlugin((ctx) => ctx.agents.registerProvider(fakeProvider('printf "%s" "$1"'))),
  );
  const start = (input = {}) =>
    core.plugins.loaded.get("customize-app")!.rpc.get("start")!(input) as Promise<{
      folderId: string;
      taskId: string;
      sessionId: string;
    }>;
  return { core, start };
}

describe("customize-app", () => {
  it("creates the app folder once and a task per press", async () => {
    const { core, start } = await setup();
    const first = await start({ title: "Настройка" });
    const second = await start({ title: "Настройка" });

    expect(core.store.folders().map((f) => f.name)).toEqual(["pitwall"]);
    expect(second.folderId).toBe(first.folderId);
    expect(core.store.tasks(first.folderId).map((t) => t.title)).toEqual(["Настройка 1", "Настройка 2"]);
  });

  it("runs the process: an agent in the app's own source directory, told about the manifesto", async () => {
    const { core, start } = await setup();
    const { sessionId } = await start();

    const session = core.sessions.get(sessionId)!;
    expect(session.cwd).toBe(root);
    await waitFor(() => core.sessions.scrollback(sessionId).includes("forkware/manifesto.md"));
  });

  it("starts the agent on a request another plugin hands in", async () => {
    const { core, start } = await setup();
    const { sessionId } = await start({ request: "Install Whisper for voice input" });
    await waitFor(() => core.sessions.scrollback(sessionId).includes("Install Whisper for voice input"));
    expect(core.sessions.scrollback(sessionId)).not.toContain("Ask them what they want");
  });

  it("recreates the folder if the user deleted it", async () => {
    const { core, start } = await setup();
    const { folderId } = await start();
    core.store.deleteFolder(folderId);
    const again = await start();
    expect(again.folderId).not.toBe(folderId);
    expect(core.store.folders()).toHaveLength(1);
  });

  it("takes over the folder made when the plugin was called improve-app", async () => {
    const core = await testCore({ defaultProvider: "fake" });
    const old = core.store.createFolder({ name: "pitwall", meta: { "improve-app": { app: true } } });
    const dir = join(root, "plugins", "customize-app");
    const manifest = JSON.parse(readFileSync(join(dir, "plugin.json"), "utf8"));
    const plugin = (await import(join(dir, "server.ts"))).default;
    await core.plugins.load("customize-app", manifest, plugin);

    expect(core.store.folders()).toHaveLength(1);
    expect(core.store.folders()[0].meta["customize-app"]).toEqual({ app: true });
    const task = core.store.createTask({ folderId: old.id, title: "Improvement 1" });
    expect(core.sessions.ofFolder(task.id)).toBe(root);
  });
});
