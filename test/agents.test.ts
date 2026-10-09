import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { definePlugin, type AgentProvider } from "../src/sdk/server.ts";
import { startHttp } from "../src/server/http.ts";
import { BUSY_MS, stripAnsi } from "../src/server/sessions.ts";
import { testCore, waitFor } from "./helpers.ts";

const posix = process.platform !== "win32";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const sh = (script: string, extra: Partial<AgentProvider> = {}): AgentProvider => ({
  id: "fake",
  label: "Fake agent",
  command: "sh",
  args: ({ prompt }) => ["-c", script, "fake", prompt ?? ""],
  ...extra,
});

async function setup(provider: AgentProvider) {
  const core = await testCore({ defaultProvider: "fake" });
  await core.plugins.load(
    "fake",
    { permissions: { "agents:provide": "", "tasks:write": "" } },
    definePlugin((ctx) => {
      ctx.agents.registerProvider(provider);
      ctx.agents.onSignal({
        name: "rename",
        description: "renames the task",
        handler: ({ task, text }) => void ctx.tasks.update(task.id, { title: text }),
      });
    }),
  );
  const folder = core.store.createFolder({ name: "F" });
  const task = core.store.createTask({ folderId: folder.id, title: "T" });
  return { core, task };
}

describe("stripAnsi", () => {
  it("leaves the text a person reads", () => {
    expect(stripAnsi("\x1b]0;title\x07\x1b[1;32mDo you want\x1b[0m to proceed?\r\n")).toBe(" Do you want to proceed?\n");
  });
});

describe.skipIf(!posix)("agents", () => {
  it("an agent tells the app about its task with pitwall, over HTTP with its own token", async () => {
    const { core, task } = await setup(sh('pitwall rename "Named by the agent"; pitwall help; pitwall nope; exec sleep 5'));
    const http = await startHttp(core, { host: "127.0.0.1", port: 0, token: "t", built: true });
    try {
      const session = core.sessions.start(task.id);
      await waitFor(() => core.store.task(task.id)?.title === "Named by the agent");
      await waitFor(() => core.sessions.screen(session.id).includes("Unknown: nope"));
      expect(core.sessions.screen(session.id)).toContain("pitwall rename");
      expect(core.state().signals).toEqual([{ name: "rename", description: "renames the task", plugin: "fake" }]);

      const forged = await fetch(`http://127.0.0.1:${http.port}/api/agent/signal`, {
        method: "POST",
        headers: { authorization: "Agent nope" },
        body: JSON.stringify({ name: "rename", text: "x" }),
      });
      expect(forged.status).toBe(401);
    } finally {
      await http.close();
    }
  });

  it("sends a message into a running agent, whole, then Enter", async () => {
    const { core, task } = await setup(sh("exec cat"));
    const session = core.sessions.start(task.id);
    core.sessions.send(session.id, "line one\nline two");
    await waitFor(() => core.sessions.screen(session.id).includes("line two"));
    expect(core.sessions.get(session.id)?.lastInputAt).toBeNull(); // the app typed, not the user
    core.sessions.write(session.id, "x");
    expect(core.sessions.get(session.id)?.lastInputAt).toBeGreaterThan(0);
  });

  it(
    "knows a quiet agent that asks the user from its provider",
    async () => {
      const { core, task } = await setup(sh('printf "Allow it? (y/n)"; exec sleep 30', { asks: (screen) => screen.includes("Allow it?") }));
      const session = core.sessions.start(task.id);
      await waitFor(() => core.sessions.get(session.id)!.lastOutputAt !== null);
      expect(core.sessions.get(session.id)?.asking).toBe(false);
      await waitFor(() => core.sessions.get(session.id)!.asking, BUSY_MS + 3000);
    },
    BUSY_MS + 6000,
  );

  it(
    "counts a quiet agent waiting to go on by itself (a usage limit) as busy, without holding a restart",
    async () => {
      const { core, task } = await setup(sh('printf "Usage limit reached"; exec sleep 30', { waits: (screen) => screen.includes("Usage limit") }));
      const session = core.sessions.start(task.id);
      await waitFor(() => core.sessions.get(session.id)!.lastOutputAt !== null);
      await waitFor(() => core.sessions.get(session.id)!.waiting, BUSY_MS + 3000);
      expect(core.sessions.get(session.id)).toMatchObject({ busy: true, asking: false, waiting: true });
      expect(core.sessions.busy()).toEqual([]);
    },
    BUSY_MS + 6000,
  );

  it("runs an agent once without a terminal: its output file wins over what it printed", async () => {
    const { core } = await setup(
      sh("", { exec: ({ prompt, outputFile }) => ["-c", `echo printed; [ "$1" = file ] && echo "  answer  " > "$2"; true`, "x", prompt, outputFile] }),
    );
    expect(await core.sessions.run("stdout")).toBe("printed");
    expect(await core.sessions.run("file")).toBe("answer");
    await expect(core.sessions.run("x", { provider: "missing" })).rejects.toThrow(/without a terminal/);
  });

  it("runs an agent with no exec in a terminal nobody sees: it answers, asks the user and reports", async () => {
    const { core } = await setup(
      sh('pitwall progress "reading"; pitwall ask "Which one?"; read line; pitwall answer "got $line"; exec sleep 30'),
    );
    const http = await startHttp(core, { host: "127.0.0.1", port: 0, token: "t", built: true });
    try {
      const progress: string[] = [];
      let control: import("../src/sdk/server.ts").RunControl | undefined;
      const answer = core.sessions.run("do it", {
        fallback: "session",
        onStart: (c) => (control = c),
        onProgress: (text) => progress.push(text),
        onAsk: (question) => {
          progress.push(`asked: ${question}`);
          control!.reply("the second");
        },
      });
      expect(control).toMatchObject({ mode: "session", provider: "fake" });
      expect(await answer).toContain("the second");
      expect(progress).toEqual(["reading", "asked: Which one?"]);
      // Nothing of it is a task's session.
      expect(core.sessions.list()).toEqual([]);
    } finally {
      await http.close();
    }
  });

  it("keeps the session for more questions", async () => {
    const { core } = await setup(
      sh('pitwall answer "first"; read line; pitwall answer "second: $line"; echo still here; exec sleep 30'),
    );
    const http = await startHttp(core, { host: "127.0.0.1", port: 0, token: "t", built: true });
    try {
      let control: import("../src/sdk/server.ts").RunControl | undefined;
      expect(await core.sessions.run("x", { fallback: "session", keep: true, onStart: (c) => (control = c) })).toBe("first");
      expect(await control!.ask("more")).toContain("more");
      control!.stop();
    } finally {
      await http.close();
    }
  });

  it("fails a run past its deadline with what it printed", async () => {
    const { core } = await setup(sh("echo thinking hard; exec sleep 30"));
    const http = await startHttp(core, { host: "127.0.0.1", port: 0, token: "t", built: true });
    try {
      const late = core.sessions.run("x", { fallback: "session", timeoutMs: 1500 });
      await expect(late).rejects.toMatchObject({ timeout: true, screen: expect.stringContaining("thinking hard") });
    } finally {
      await http.close();
    }
  });

  it("falls back to a terminal when the run without one fails", async () => {
    const { core } = await setup(sh('pitwall answer "from the terminal"; exec sleep 30', { exec: () => ["-c", "exit 3"] }));
    const http = await startHttp(core, { host: "127.0.0.1", port: 0, token: "t", built: true });
    try {
      expect(await core.sessions.run("x", { fallback: "session" })).toBe("from the terminal");
      await expect(core.sessions.run("x")).rejects.toThrow(/failed/);
    } finally {
      await http.close();
    }
  });

  it("starts the task's agents in its own workspace before the folder's", async () => {
    const { core, task } = await setup(sh("exec sleep 5"));
    const own = mkdtempSync(join(tmpdir(), "agent-ws-"));
    dirs.push(own);
    core.store.updateTask(task.id, { workspace: own });
    expect(core.sessions.start(task.id).cwd).toBe(own);
    expect(core.sessions.ofFolder(task.id)).toBeUndefined();
    core.store.updateTask(task.id, { workspace: null });
    expect(core.sessions.start(task.id).cwd).toContain(task.id); // the scratch directory
  });
});
