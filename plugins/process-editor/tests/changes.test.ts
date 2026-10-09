import { describe, expect, it } from "vitest";
import { definePlugin, type AgentProvider, type PluginContext, type ProcessSpec } from "../../../src/sdk/server.ts";
import { startHttp } from "../../../src/server/http.ts";
import { testCore, waitFor } from "../../../test/helpers.ts";
import editor from "../server.ts";
import type { Job } from "../changes.ts";
import { parseAnswer } from "../prompts.ts";

const posix = process.platform !== "win32";
const all = { "steps:register": "", "processes:register": "", "processes:run": "", "agents:spawn": "", "agents:provide": "" };

const base: ProcessSpec = {
  id: "w",
  label: "W",
  nodes: { ask: "steps.ask", fix: "steps.fix" },
  edges: [
    ["start", "ask"],
    ["ask", "fix"],
    ["fix", "end"],
  ],
};
const proposal: ProcessSpec = { ...base, nodes: { fix: "steps.fix" }, edges: [["start", "fix"], ["fix", "end"]] };
const json = (spec: ProcessSpec) => JSON.stringify({ spec, note: "Без вопроса" }).replace(/'/g, "");

async function setup(provider: AgentProvider) {
  const core = await testCore({ defaultProvider: "fake" });
  await core.plugins.load(
    "steps",
    { permissions: all },
    definePlugin((ctx: PluginContext) => {
      ctx.agents.registerProvider(provider);
      ctx.steps.register({ id: "fix", label: "Fix", run: () => {} });
      ctx.steps.register({ id: "ask", label: "Ask", run: ({ ask }) => void ask({ kind: "choice", title: "?", options: [{ id: "y", label: "Y" }] }) });
      ctx.processes.register({ ...base, edges: base.edges as never });
    }),
  );
  const loaded = await core.plugins.load("process-editor", { permissions: all }, editor);
  const http = await startHttp(core, { host: "127.0.0.1", port: 0, token: "t", built: true });
  const jobs: Job[] = [];
  core.events.on("process-editor.job", (job: Job) => jobs.push(job));
  const call = <T,>(name: string, input: unknown) => loaded.rpc.get(name)!(input) as T;
  const last = () => jobs.at(-1);
  return { core, call, last, close: () => http.close() };
}

describe("parseAnswer", () => {
  it("takes the JSON out of a fenced or a chatty answer", () => {
    expect(parseAnswer('Here:\n```json\n{"question": "Which folder?"}\n```')).toEqual({ question: "Which folder?" });
    expect(parseAnswer('Sure. {"needsCode": "post to Slack"} Done.')).toEqual({ needsCode: "post to Slack" });
    expect(() => parseAnswer("no json here")).toThrow(/not JSON/);
  });
});

describe.skipIf(!posix)("changing a process in words", () => {
  it("an agent without a terminal proposes a change; its problems are checked first", async () => {
    const { call, last, close } = await setup({
      id: "fake",
      label: "Fake",
      command: "sh",
      exec: () => ["-c", `printf '%s' '${json(proposal)}'`],
    });
    try {
      const job = call<Job>("change", { process: "steps.w", spec: base, request: "не спрашивай" });
      expect(job.status).toBe("working");
      await waitFor(() => last()?.status === "proposal");
      expect(last()).toMatchObject({ mode: "exec", suggestSwitch: false, proposal: { note: "Без вопроса", issues: [] } });
      expect(Object.keys(last()!.proposal!.spec.nodes)).toEqual(["fix"]);
      expect(last()!.proposal!.spec.id).toBe("w");
    } finally {
      await close();
    }
  });

  it("an agent with no exec answers from a terminal nobody sees, after fixing an answer that was not JSON", async () => {
    const { call, last, close } = await setup({
      id: "fake",
      label: "Fake",
      command: "sh",
      args: () => ["-c", `pitwall progress "reading"; pitwall answer "sure, will do"; read line; printf '%s' '${json(proposal)}' | pitwall answer; exec sleep 30`],
    });
    try {
      call<Job>("change", { process: "steps.w", spec: base, request: "не спрашивай" });
      await waitFor(() => last()?.status === "proposal", 10000);
      expect(last()).toMatchObject({ mode: "session", suggestSwitch: true, proposal: { issues: [] } });
      call("snoozeSwitch", { never: true });
      expect(last()?.suggestSwitch).toBe(false);
      call("close", { id: last()!.id });
    } finally {
      await close();
    }
  }, 15000);

  it("shows the agent's question and sends the answer back", async () => {
    const { call, last, close } = await setup({
      id: "fake",
      label: "Fake",
      command: "sh",
      args: () => ["-c", `pitwall ask "Для какой папки?"; read line; printf '%s' '${json(proposal)}' | pitwall answer; exec sleep 30`],
    });
    try {
      const job = call<Job>("change", { process: "steps.w", spec: base, request: "не спрашивай" });
      await waitFor(() => last()?.status === "asking");
      expect(last()?.question).toBe("Для какой папки?");
      call("reply", { id: job.id, text: "work" });
      await waitFor(() => last()?.status === "proposal", 10000);
      call("close", { id: job.id });
    } finally {
      await close();
    }
  }, 15000);
});
