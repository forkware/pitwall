// "What to change?": an agent changes a process as the user asks. Without a terminal when it can, else in a terminal
// nobody sees; its proposal is checked, sent back to it to fix (twice at most), then shown to the user.
import { randomUUID } from "node:crypto";
import type { PluginContext, RunControl, ProcessInfo, ProcessSpec } from "#sdk/server";
import { MINE_PLUGIN } from "./ids.ts";
import { changePrompt, fixPrompt, parseAnswer, refinePrompt, type ChangeAnswer } from "./prompts.ts";

export type JobStatus = "working" | "asking" | "permission" | "silent" | "proposal" | "needsCode" | "failed" | "stopped";

export interface Job {
  id: string;
  process: string;
  status: JobStatus;
  mode: "exec" | "session" | null;
  sessionId: string | null;
  provider: string | null;
  progress: string | null;
  question: string | null;
  /** The end of the agent's screen: while it waits for a permission, or after it failed. */
  screen: string | null;
  proposal: { spec: ProcessSpec; note: string | null; issues: string[] } | null;
  needsCode: string | null;
  error: string | null;
  startedAt: number;
  deadline: number | null;
  /** The agent ran in a terminal: offer one that answers without a terminal, once. */
  suggestSwitch: boolean;
}

interface Running {
  job: Job;
  control: RunControl | null;
  prompt: string;
  /** The agent's last answer, for a new run without a terminal. */
  last: string | null;
  base: ProcessSpec;
  folderId: string | null;
  /** Problems the process already had: the agent need not fix them. */
  known: Set<string>;
  /** The agent asked with `pitwall ask` and waits in its terminal for the answer. */
  waitsInTerminal: boolean;
}

export function makeChanges(ctx: PluginContext) {
  const jobs = new Map<string, Running>();
  const emit = (r: Running) => ctx.events.emit("job", { ...r.job });
  const setting = <T,>(key: string, folderId: string | null) => ctx.settings.get<T>(key, folderId);
  const pluginOf = (id: string) => ctx.processes.list().find((w) => w.id === id)?.plugin ?? MINE_PLUGIN;

  /** Problems of a proposal the process did not have before. */
  const newProblems = (r: Running, spec: ProcessSpec): string[] => {
    try {
      return ctx.processes.preview(pluginOf(r.job.process), spec).problems.filter((p) => !r.known.has(p));
    } catch (error) {
      return [(error as Error).message];
    }
  };

  const update = (r: Running, patch: Partial<Job>) => {
    Object.assign(r.job, patch);
    emit(r);
  };

  /** Runs the agent once more: in its terminal when it has one, else a new run with the conversation so far. */
  async function ask(r: Running, words: string | null, fixes = 0): Promise<void> {
    const switchState = ctx.kv.get<{ never?: boolean; until?: number }>("switch") ?? {};
    const onStart = (control: RunControl) => {
      r.control = control;
      const offer = control.mode === "session" && !switchState.never && (switchState.until ?? 0) < Date.now();
      update(r, { mode: control.mode, sessionId: control.sessionId, provider: control.provider, suggestSwitch: offer });
    };
    update(r, { status: "working", error: null, question: null, screen: null, needsCode: null });
    let text: string;
    try {
      if (words !== null && r.control?.mode === "session") text = await r.control.ask(words);
      else {
        const prompt = words === null ? r.prompt : refinePrompt(r.prompt, r.last, words);
        const agent = setting<string>("agent", r.folderId) || undefined;
        text = await ctx.agents.run(prompt, {
          provider: agent,
          folderId: r.folderId ?? undefined,
          fallback: "session",
          keep: true,
          timeoutMs: (setting<number>("answerMinutes", r.folderId) || 5) * 60_000,
          onStart,
          onProgress: (progress) => update(r, { progress }),
          onAsk: (question) => {
            r.waitsInTerminal = true;
            update(r, { status: "asking", question });
          },
          onActivity: ({ asking, silentFor, deadline }) => {
            const silence = (setting<number>("silenceSeconds", r.folderId) || 60) * 1000;
            const next: JobStatus | null =
              r.job.status === "asking" ? null : asking ? "permission" : silentFor >= silence ? "silent" : "working";
            if (next && (next !== r.job.status || r.job.deadline !== deadline)) {
              update(r, { status: next, deadline, screen: asking && r.control ? r.control.screen() : null });
            }
          },
        });
      }
    } catch (error) {
      if (r.job.status === "stopped") return;
      const e = error as Error & { screen?: string; timeout?: boolean; stopped?: boolean };
      update(r, { status: e.stopped ? "stopped" : "failed", error: e.timeout ? "timeout" : e.message, screen: e.screen ?? null });
      return;
    }
    r.last = text;
    let answer: ChangeAnswer;
    try {
      answer = parseAnswer(text);
    } catch (error) {
      if (fixes < 2) return ask(r, `${(error as Error).message}. Answer with the JSON only.`, fixes + 1);
      update(r, { status: "failed", error: (error as Error).message, screen: text.slice(-3000) });
      return;
    }
    if ("question" in answer) return update(r, { status: "asking", question: answer.question });
    if ("needsCode" in answer) return update(r, { status: "needsCode", needsCode: answer.needsCode });
    const spec: ProcessSpec = { ...answer.spec, id: r.base.id, ...(r.base.overrides ? { overrides: r.base.overrides } : {}), ...(r.base.base ? { base: r.base.base } : {}) };
    const problems = newProblems(r, spec);
    if (problems.length && fixes < 2) return ask(r, fixPrompt(problems), fixes + 1);
    update(r, { status: "proposal", proposal: { spec, note: answer.note ?? null, issues: problems }, progress: null });
  }

  return {
    start(input: { process: string; spec: ProcessSpec; request: string; node?: string; folderId?: string | null; lang?: string }): Job {
      const def: ProcessInfo | undefined = ctx.processes.list().find((w) => w.id === input.process);
      const known = new Set(def ? def.problems : []);
      const job: Job = {
        id: randomUUID(),
        process: input.process,
        status: "working",
        mode: null,
        sessionId: null,
        provider: null,
        progress: null,
        question: null,
        screen: null,
        proposal: null,
        needsCode: null,
        error: null,
        startedAt: Date.now(),
        deadline: null,
        suggestSwitch: false,
      };
      // In a terminal, the core tells the agent how to answer.
      const prompt = changePrompt({
        spec: input.spec,
        request: input.request,
        steps: ctx.steps.list(),
        processes: ctx.processes.list(),
        statuses: ctx.statuses.list(),
        node: input.node,
        lang: input.lang === "ru" ? "Russian" : "English",
      });
      const r: Running = { job, control: null, prompt, last: null, base: input.spec, folderId: input.folderId ?? null, known, waitsInTerminal: false };
      jobs.set(job.id, r);
      void ask(r, null);
      return { ...job };
    },

    get(id: string): Job | undefined {
      const r = jobs.get(id);
      return r ? { ...r.job } : undefined;
    },

    /** The user's answer to the agent's question. */
    reply(id: string, text: string): void {
      const r = must(id);
      if (r.waitsInTerminal && r.control) {
        r.waitsInTerminal = false;
        update(r, { status: "working", question: null });
        r.control.reply(text);
        return;
      }
      void ask(r, `The answer to your question: ${text}`);
    },

    /** More words after a proposal: "no, only for the work folder". */
    refine(id: string, text: string): void {
      void ask(must(id), text);
    },

    /** Waits five minutes more. */
    wait(id: string): void {
      const r = must(id);
      r.control?.extend(5 * 60_000);
      update(r, { status: "working" });
    },

    stop(id: string): void {
      const r = jobs.get(id);
      if (!r) return;
      update(r, { status: "stopped" });
      r.control?.stop();
    },

    /** The job is over: the proposal was taken or dropped. */
    close(id: string): void {
      const r = jobs.get(id);
      if (!r) return;
      jobs.delete(id);
      try {
        r.control?.stop();
      } catch {}
    },

    /** "Not now": ask again in a week. "Never": not again. */
    snoozeSwitch(never: boolean): void {
      ctx.kv.set("switch", never ? { never: true } : { until: Date.now() + 7 * 24 * 3600_000 });
      for (const r of jobs.values()) update(r, { suggestSwitch: false });
    },

    stopAll(): void {
      for (const id of [...jobs.keys()]) this.close(id);
    },
  };

  function must(id: string): Running {
    const r = jobs.get(id);
    if (!r) throw new Error("This change is over: start it again");
    return r;
  }
}
