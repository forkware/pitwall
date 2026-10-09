import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { definePlugin, type AgentProvider } from "../src/sdk/server.ts";
import type { Core } from "../src/server/app.ts";
import { QUIET_MS } from "../src/server/restart.ts";
import { BUSY_MS, REDRAW_MS } from "../src/server/sessions.ts";
import { testCore, waitFor } from "./helpers.ts";

const posix = process.platform !== "win32";

const dataDirs: string[] = [];
afterEach(() => {
  for (const dir of dataDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
/** A data directory that outlives a core, as the app's does across a restart. */
function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-restart-"));
  dataDirs.push(dir);
  return dir;
}

/** An agent run by sh: `script` for a new session, `resumed` for one continued by `codex resume`-like arguments. */
const agent = (script: string, resume?: { find: () => string | undefined; resumed: string }): AgentProvider => ({
  id: "fake",
  label: "Fake agent",
  command: "sh",
  args: ({ sessionId }) => ["-c", script, "fake", sessionId],
  resume: resume && { find: resume.find, args: (id) => ["-c", resume.resumed, "fake", id] },
});

async function withAgent(provider: AgentProvider, options: Parameters<typeof testCore>[0] = {}) {
  const core = await testCore({ defaultProvider: "fake", ...options });
  await core.plugins.load("test", { permissions: { "agents:provide": "" } }, definePlugin((ctx) => ctx.agents.registerProvider(provider)));
  const task = core.store.createTask({ folderId: core.store.createFolder({ name: "A" }).id, title: "T" });
  return { core, task };
}

/** Prints for a while, then waits for input as an agent waiting for the user does. */
const WORK_THEN_WAIT = 'i=0; while [ $i -lt 10 ]; do echo working; sleep 0.2; i=$((i+1)); done; echo done; read x';

describe.skipIf(!posix)("agent activity", () => {
  it("is busy while the agent prints and idle once it waits", async () => {
    const { core, task } = await withAgent(agent(WORK_THEN_WAIT));
    const session = core.sessions.start(task.id);
    await waitFor(() => core.sessions.get(session.id)!.busy, 3000);
    expect(core.sessions.busy().map((s) => s.id)).toEqual([session.id]);
    await waitFor(() => !core.sessions.get(session.id)!.busy, 2000 + BUSY_MS + 2000);
    expect(core.sessions.busy()).toEqual([]);
  }, 15_000);

  it("is not busy when it redraws its screen for a resize", async () => {
    // Like Claude Code: a resize makes it print its whole screen again.
    const { core, task } = await withAgent(agent('trap "echo redrawn" WINCH; echo ready; while :; do sleep 0.1; done'));
    const session = core.sessions.start(task.id);
    await waitFor(() => core.sessions.get(session.id)!.busy, 3000);
    await waitFor(() => !core.sessions.get(session.id)!.busy, BUSY_MS + 2000);
    const before = core.sessions.get(session.id)!.lastOutputAt;
    core.sessions.resize(session.id, 100, 30);
    await waitFor(() => core.sessions.scrollback(session.id).includes("redrawn"));
    await new Promise((r) => setTimeout(r, 1100));
    expect(core.sessions.get(session.id)).toMatchObject({ busy: false, lastOutputAt: before });
    // The same size again is no resize.
    core.sessions.resize(session.id, 100, 30);
    await new Promise((r) => setTimeout(r, REDRAW_MS));
    expect((core.sessions.scrollback(session.id).match(/redrawn/g) ?? []).length).toBe(1);
  }, 15_000);
});

describe.skipIf(!posix)("resuming after a restart", () => {
  /** The app stopped while the session ran, and started again on the same data. */
  async function restart(core: Core, provider: AgentProvider, dir: string) {
    core.sessions.stopAll();
    const again = await testCore({ dataDir: dir, defaultProvider: "fake" });
    await again.plugins.load("test", { permissions: { "agents:provide": "" } }, definePlugin((ctx) => ctx.agents.registerProvider(provider)));
    return again;
  }

  it("keeps the conversation id, suspends the session and resumes it in that conversation", async () => {
    const provider = agent('echo "new $1"; read x', { find: () => "conv-1", resumed: 'echo "resumed $1"; read x' });
    const dir = dataDir();
    const { core, task } = await withAgent(provider, { dataDir: dir });
    const session = core.sessions.start(task.id);
    // The core asks the provider each second while the agent runs.
    await waitFor(() => core.sessions.get(session.id)!.agentSessionId === "conv-1", 3000);

    const again = await restart(core, provider, dir);
    expect(again.sessions.get(session.id)).toMatchObject({ state: "suspended", agentSessionId: "conv-1" });

    again.sessions.resume(session.id);
    await waitFor(() => again.sessions.scrollback(session.id).includes("resumed conv-1"));
    expect(again.sessions.get(session.id)!.state).toBe("running");
    // The earlier output stays above.
    expect(again.sessions.scrollback(session.id)).toContain(`new ${session.id}`);
  });

  it("starts afresh when the agent has no conversation to resume yet", async () => {
    const provider = agent('echo "new $1"; read x', { find: () => undefined, resumed: 'echo "resumed $1"; read x' });
    const dir = dataDir();
    const { core, task } = await withAgent(provider, { dataDir: dir });
    const session = core.sessions.start(task.id);
    await waitFor(() => core.sessions.scrollback(session.id).includes("new"));

    const again = await restart(core, provider, dir);
    again.sessions.resume(session.id);
    await waitFor(() => (again.sessions.scrollback(session.id).match(/new /g) ?? []).length === 2);
    expect(again.sessions.scrollback(session.id)).not.toContain("resumed");
  });

  it("brings back an agent killed while the restart waited, in its conversation", async () => {
    const provider = agent('echo "new $1"; read x', { find: () => "conv-1", resumed: 'echo "resumed $1"; read x' });
    const { core, task } = await withAgent(provider);
    const session = core.sessions.start(task.id);
    await waitFor(() => core.sessions.scrollback(session.id).includes("new"));

    core.sessions.suspend(session.id);
    await waitFor(() => core.sessions.get(session.id)!.state === "suspended");
    expect(core.sessions.get(session.id)!.agentSessionId).toBe("conv-1");
    core.sessions.resume(session.id);
    await waitFor(() => core.sessions.scrollback(session.id).includes("resumed conv-1"));
  });

  it("does not bring back an agent whose directory is gone, and says why", async () => {
    const provider = agent('echo "new $1"; read x', { find: () => "conv-1", resumed: 'echo "resumed $1"; read x' });
    const { core, task } = await withAgent(provider);
    const cwd = join(dataDir(), "worktree");
    mkdirSync(cwd);
    core.store.updateTask(task.id, { workspace: cwd });
    const session = core.sessions.start(task.id);
    await waitFor(() => core.sessions.scrollback(session.id).includes("new"));
    core.sessions.suspend(session.id);
    await waitFor(() => core.sessions.get(session.id)!.state === "suspended");

    rmSync(cwd, { recursive: true });
    core.sessions.resume(session.id);
    expect(core.sessions.get(session.id)).toMatchObject({ state: "exited", exitReason: "gone" });
    expect(core.sessions.scrollback(session.id)).toContain(`${cwd} is gone`);
    expect(core.sessions.scrollback(session.id)).not.toContain("resumed");
  });

  it("does not bring back an agent that exited by itself", async () => {
    const provider = agent("echo bye", { find: () => "conv-1", resumed: "echo resumed; read x" });
    const { core, task } = await withAgent(provider);
    const session = core.sessions.start(task.id);
    await waitFor(() => core.sessions.get(session.id)!.state === "exited");
    core.sessions.resume(session.id);
    expect(core.sessions.get(session.id)!.state).toBe("exited");
  });
});

describe.skipIf(!posix)("restart when the agents are done", () => {
  it("waits while an agent works, then restarts", async () => {
    let restarts = 0;
    const { core, task } = await withAgent(agent(WORK_THEN_WAIT), { restart: () => restarts++ });
    expect(core.app.restartable).toBe(true);
    const session = core.sessions.start(task.id);
    await waitFor(() => core.sessions.get(session.id)!.busy, 3000);

    core.restart.request();
    expect(core.state().restart).toEqual({ pending: true });
    await new Promise((r) => setTimeout(r, 1000));
    expect(restarts).toBe(0);

    await waitFor(() => restarts === 1, 2000 + BUSY_MS + QUIET_MS + 2000);
    expect(core.state().restart).toBeNull();
  }, 20_000);

  it("can be called off", async () => {
    let restarts = 0;
    const { core } = await withAgent(agent("read x"), { restart: () => restarts++ });
    core.restart.request();
    core.restart.cancel();
    await new Promise((r) => setTimeout(r, QUIET_MS + 500));
    expect(restarts).toBe(0);
    expect(core.state().restart).toBeNull();
  }, 10_000);
});
