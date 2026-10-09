import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { definePlugin, type AgentProvider } from "../../../src/sdk/server.ts";
import { root, testCore, waitFor } from "../../../test/helpers.ts";
import { describeEnded } from "../describe.ts";
import plugin, { freshPrompt } from "../server.ts";

const posix = process.platform !== "win32";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const resumable: AgentProvider = {
  id: "fake",
  label: "Fake agent",
  command: "sh",
  args: ({ prompt }) => ["-c", 'printf "started %s\\n" "$1"; exec sleep 30', "fake", prompt ?? ""],
  resume: { find: () => "conv-1", args: (id) => ["-c", `echo resumed ${id}; exec sleep 30`] },
};

async function setup(provider: AgentProvider = resumable, restore?: (dir: string) => void) {
  const core = await testCore({ defaultProvider: "fake" });
  const manifest = JSON.parse(readFileSync(join(root, "plugins/ended-sessions/plugin.json"), "utf8"));
  await core.plugins.load("ended-sessions", manifest, plugin);
  await core.plugins.load(
    "fake",
    { permissions: { "agents:provide": "", "workspaces:resolve": "" } },
    definePlugin((ctx) => {
      ctx.agents.registerProvider(provider);
      if (restore)
        ctx.workspaces.registerRestorer({
          offer: () => "fake.restore",
          restore: (session) => (restore(session.cwd), session.cwd),
        });
    }),
  );
  const dir = mkdtempSync(join(tmpdir(), "ended-"));
  dirs.push(dir);
  const folder = core.store.createFolder({ name: "F" });
  const task = core.store.createTask({ folderId: folder.id, title: "Fix the header", body: "It is too tall" });
  core.store.updateTask(task.id, { workspace: dir });
  const rpc = (name: string, input: unknown) => core.plugins.loaded.get("ended-sessions")!.rpc.get(name)!(input) as any;
  return { core, task, dir, rpc };
}

describe("what the card says", () => {
  const can = { possible: true, resumes: true, gone: false };
  it("names why the agent ended", () => {
    expect(describeEnded({ exitReason: "stopped", exitCode: 129 }, can).title).toBe("ended-sessions.stopped");
    expect(describeEnded({ exitReason: "dev-flow.merged", exitCode: 129 }, can).title).toBe("dev-flow.merged");
    expect(describeEnded({ exitReason: null, exitCode: 0 }, can).title).toBe("ended-sessions.finished");
    expect(describeEnded({ exitReason: null, exitCode: 1 }, can)).toMatchObject({ title: "ended-sessions.failed", vars: { code: 1 } });
  });

  it("offers to continue the conversation, to restore a removed directory, or only a new agent", () => {
    expect(describeEnded({ exitReason: null, exitCode: 0 }, can)).toMatchObject({ action: "ended-sessions.continue" });
    expect(describeEnded({ exitReason: null, exitCode: 0 }, { ...can, resumes: false }).action).toBe("ended-sessions.startAgain");
    expect(describeEnded({ exitReason: "gone", exitCode: null }, { ...can, gone: true, restore: "dev-flow.restoreWorktree" })).toMatchObject({
      detail: "dev-flow.restoreWorktree",
      action: "ended-sessions.restoreAndContinue",
    });
    const none = describeEnded({ exitReason: "gone", exitCode: null }, { possible: false, resumes: false, gone: true });
    expect(none).toMatchObject({ detail: "ended-sessions.cannotGone" });
    expect(none.action).toBeUndefined();
  });

  it("starts a new agent with the task's title and description", () => {
    expect(freshPrompt({ title: "Fix the header", body: "It is too tall" } as any)).toBe("Fix the header\n\nIt is too tall");
    expect(freshPrompt({ title: "Fix the header", body: "" } as any)).toBe("Fix the header");
  });
});

describe.skipIf(!posix)("ended agents", () => {
  it("continues a stopped agent's conversation in the same tab", async () => {
    const { core, task, rpc } = await setup();
    const session = core.sessions.start(task.id);
    await waitFor(() => core.sessions.screen(session.id).includes("started"));
    core.sessions.kill(session.id);
    await waitFor(() => core.sessions.get(session.id)?.state === "exited");
    expect(core.sessions.get(session.id)).toMatchObject({ exitReason: "stopped" });
    expect(await rpc("continuation", { sessionId: session.id })).toEqual({ possible: true, resumes: true, gone: false });

    await rpc("continue", { sessionId: session.id });
    expect(core.sessions.get(session.id)).toMatchObject({ state: "running", exitReason: null, exitCode: null });
    await waitFor(() => core.sessions.screen(session.id).includes("resumed conv-1"));
    expect(core.sessions.list(task.id)).toHaveLength(1);
  });

  it("an agent that exited by itself has no reason, and starts afresh when it cannot resume", async () => {
    const { core, task, rpc } = await setup({ ...resumable, resume: undefined, args: () => ["-c", "echo once"] });
    const session = core.sessions.start(task.id);
    await waitFor(() => core.sessions.get(session.id)?.state === "exited");
    expect(core.sessions.get(session.id)).toMatchObject({ exitReason: null, exitCode: 0 });
    expect(await rpc("continuation", { sessionId: session.id })).toMatchObject({ possible: true, resumes: false });
  });

  it("cannot continue in a removed directory without a plugin that restores it; a new agent gets the task", async () => {
    const { core, task, dir, rpc } = await setup();
    const session = core.sessions.start(task.id);
    core.sessions.kill(session.id);
    await waitFor(() => core.sessions.get(session.id)?.state === "exited");
    rmSync(dir, { recursive: true });
    expect(await rpc("continuation", { sessionId: session.id })).toEqual({ possible: false, resumes: true, gone: true });
    expect(() => rpc("continue", { sessionId: session.id })).toThrow(/is gone/);

    const fresh = await rpc("fresh", { sessionId: session.id });
    expect(fresh.id).not.toBe(session.id);
    await waitFor(() => core.sessions.screen(fresh.id).includes("started Fix the header"));
  });

  it("continues in the same place after a plugin restored the removed directory", async () => {
    const { core, task, dir, rpc } = await setup(resumable, (cwd) => mkdirSync(cwd, { recursive: true }));
    const session = core.sessions.start(task.id);
    core.sessions.kill(session.id);
    await waitFor(() => core.sessions.get(session.id)?.state === "exited");
    rmSync(dir, { recursive: true });
    expect(await rpc("continuation", { sessionId: session.id })).toMatchObject({ possible: true, gone: true, restore: "fake.restore" });

    await rpc("continue", { sessionId: session.id });
    expect(existsSync(dir)).toBe(true);
    expect(core.sessions.get(session.id)).toMatchObject({ state: "running", cwd: dir });
    await waitFor(() => core.sessions.screen(session.id).includes("resumed conv-1"));
  });
});
