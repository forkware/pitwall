import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { definePlugin } from "../../../src/sdk/server.ts";
import { startHttp } from "../../../src/server/http.ts";
import { fakeProvider, root, testCore, waitFor } from "../../../test/helpers.ts";
import { fill, options } from "../text.ts";

const posix = process.platform !== "win32";

async function setup(agent = "sleep 30") {
  const core = await testCore({ pluginsDir: join(root, "plugins"), defaultProvider: "fake" });
  await core.plugins.load("fake", { permissions: { "agents:provide": "" } }, definePlugin((ctx) => ctx.agents.registerProvider(fakeProvider(agent))));
  const folder = core.store.createFolder({ name: "F" });
  return { core, folder };
}

/** A process in code, so the tests write no files into the repository. */
async function register(core: Awaited<ReturnType<typeof setup>>["core"], spec: Parameters<import("../../../src/sdk/server.ts").PluginContext["processes"]["register"]>[0]) {
  await core.plugins.load("flows", { permissions: { "processes:register": "" } }, definePlugin((ctx) => ctx.processes.register(spec)));
}

describe("texts", () => {
  it("reads answers one per line, with a status after an arrow", () => {
    expect(options("Done → done\n\nOnce more\nDone")).toEqual([
      { id: "Done", label: "Done", status: "done" },
      { id: "Once more", label: "Once more" },
    ]);
  });

  it("fills a prompt with the task and the keys", () => {
    expect(fill("{{task.title}}: {{agent.answer}} {{ nothing }}", { title: "T", body: "" }, { "agent.answer": "yes" })).toBe("T: yes");
  });
});

describe("basic steps", () => {
  it("the templates can run, and are templates", async () => {
    const { core } = await setup();
    const templates = core.processes.list().filter((w) => w.plugin === "basic-steps");
    expect(templates.map((w) => [w.id, w.template, w.problems])).toEqual([
      ["basic-steps.agent-check", true, []],
      ["basic-steps.research-draft", true, []],
      ["basic-steps.triage", true, []],
    ]);
  });

  it("Ask me: the answers come from its card, the process branches on them, an answer moves the status", async () => {
    const { core, folder } = await setup();
    await register(core, {
      id: "q",
      label: "Q",
      nodes: { q: { step: "basic-steps.ask", params: { question: "Ship?", options: "Ship → done\nNot yet" } }, cmd: { step: "basic-steps.command", params: { command: "true" } } },
      edges: [
        ["start", "q"],
        ["q", { on: "choice.answer", cases: { Ship: "end" }, else: "cmd" }],
        ["cmd", "end"],
      ],
    });
    const info = core.processes.get("flows.q")!;
    expect(info.nodes[0]).toMatchObject({ role: "you", outcomes: { "choice.answer": { Ship: "Ship", "Not yet": "Not yet" } } });
    expect(info.asks).toBe(1);
    const task = core.processes.createTask({ folderId: folder.id, title: "T" }, "flows.q");
    expect(await core.processes.settled(task.id)).toMatchObject({ state: "waiting", request: { title: "Ship?", options: [{ id: "Ship", status: "done" }, { id: "Not yet" }] } });
    core.processes.resume(task.id, "Not yet");
    expect(await core.processes.settled(task.id)).toMatchObject({ state: "done" });
    expect(core.processes.trace(task.id).map((e) => [e.node, e.output])).toEqual([
      ["q", { "choice.answer": "Not yet" }],
      ["cmd", { "command.passed": true, "command.output": "" }],
    ]);
  });

  it.skipIf(!posix)("Task for the agent: gives the task once, and goes on when the agent says it finished", async () => {
    const { core, folder } = await setup('printf "%s" "$1"; pitwall finished "all done"; exec sleep 30');
    const http = await startHttp(core, { host: "127.0.0.1", port: 0, token: "t", built: true });
    try {
      await register(core, {
        id: "a",
        label: "A",
        nodes: { work: { step: "basic-steps.agent-task", params: { prompt: "Do {{task.title}}" } } },
        edges: [
          ["start", "work"],
          ["work", "end"],
        ],
      });
      const task = core.processes.createTask({ folderId: folder.id, title: "the thing" }, "flows.a");
      await waitFor(() => core.processes.run(task.id)?.state === "done", 10000);
      const [session] = core.sessions.list(task.id);
      expect(core.sessions.scrollback(session.id)).toContain("Do the thing");
      expect(core.sessions.list(task.id)).toHaveLength(1);
    } finally {
      await http.close();
    }
  }, 15000);
});
