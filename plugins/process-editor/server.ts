// The editor's server part: drafts, applying them as the user's own version, history, and what the UI cannot
// read from the app's state.
import { execFile } from "node:child_process";
import { definePlugin, type PluginContext, type ProcessInfo, type ProcessSpec } from "#sdk/server";
import { makeChanges } from "./changes.ts";
import { MINE_PLUGIN as MINE } from "./ids.ts";
import { qualify } from "./specs.ts";
import { freeId } from "./build.ts";

export interface Draft {
  spec: ProcessSpec;
  at: number;
}

export default definePlugin((ctx) => {
  const editor = makeEditor(ctx);
  const changes = makeChanges(ctx);

  ctx.settings.define([
    {
      key: "agent",
      label: "Agent for changing processes",
      description: "The agent that changes a process when you say what to change. Empty: the folder's agent.",
      type: "select",
      options: () => [{ value: "", label: "The folder's agent" }, ...ctx.agents.providers().map((p) => ({ value: p.id, label: p.label }))],
      default: "",
    },
    {
      key: "silenceSeconds",
      label: "Agent is silent after, s",
      description: "An agent changing a process that prints nothing this long is shown as silent, with Wait and Stop.",
      type: "number",
      default: 60,
    },
    {
      key: "habitAnswers",
      label: "Offer not to ask after, same answers",
      description: "After this many same answers in a row to a question, the task offers not to ask it any more. 0: never.",
      type: "number",
      default: 5,
    },
    {
      key: "answerMinutes",
      label: "Time for an answer, min",
      description: "An agent changing a process is stopped after this long unless you wait more.",
      type: "number",
      default: 5,
    },
  ]);

  ctx.rpc.handle("change", (input: Parameters<typeof changes.start>[0]) => changes.start(input));
  ctx.rpc.handle("job", ({ id }: { id: string }) => changes.get(id) ?? null);
  ctx.rpc.handle("reply", ({ id, text }: { id: string; text: string }) => changes.reply(id, text));
  ctx.rpc.handle("refine", ({ id, text }: { id: string; text: string }) => changes.refine(id, text));
  ctx.rpc.handle("wait", ({ id }: { id: string }) => changes.wait(id));
  ctx.rpc.handle("stop", ({ id }: { id: string }) => changes.stop(id));
  ctx.rpc.handle("close", ({ id }: { id: string }) => changes.close(id));
  ctx.rpc.handle("snoozeSwitch", ({ never }: { never: boolean }) => changes.snoozeSwitch(never));
  // Habits: the same answer to a question again and again is a step the process could take by itself.
  type Habit = { answer: unknown; count: number; never?: boolean };
  const habitKey = (h: { process: string; node: string | null; question: string }) => `habit:${h.process}|${h.node}|${h.question}`;
  ctx.events.on("process.answered", (e: { process: string; node: string | null; question: string; answer: unknown; automatic: boolean }) => {
    if (e.automatic || e.question === "__step" || typeof e.answer !== "string") return;
    const key = habitKey(e);
    const last = ctx.kv.get<Habit>(key);
    ctx.kv.set(key, { answer: e.answer, count: last?.answer === e.answer ? last.count + 1 : 1, ...(last?.never ? { never: true } : {}) });
  });
  ctx.rpc.handle("habit", (h: { process: string; node: string | null; question: string }) => {
    const habit = ctx.kv.get<Habit>(habitKey(h));
    const after = ctx.settings.get<number>("habitAnswers") ?? 5;
    return habit && !habit.never && after > 0 && habit.count >= after ? habit : null;
  });
  ctx.rpc.handle("habitNever", (h: { process: string; node: string | null; question: string }) => {
    const key = habitKey(h);
    ctx.kv.set(key, { ...(ctx.kv.get<Habit>(key) ?? { answer: null, count: 0 }), never: true });
  });

  // "Offer it to the shared repository" (rule 8): an issue in the app's repository with the process as a recipe.
  ctx.rpc.handle("share", async ({ id, note }: { id: string; note?: string }) => {
    const def = ctx.processes.list().find((w) => w.id === id);
    if (!def || def.plugin !== MINE) throw new Error("Only your own processes and versions can be offered");
    const { title, body } = shareIssue(def, note);
    return new Promise<string>((resolve, reject) =>
      execFile("gh", ["issue", "create", "--title", title, "--body", body], { cwd: ctx.app.root, timeout: 60_000 }, (error, out, err) =>
        error ? reject(new Error((err || error.message).trim().slice(-500))) : resolve(out.trim()),
      ),
    );
  });

  ctx.rpc.handle("create", ({ spec }: { spec: ProcessSpec }) => editor.create(spec));
  ctx.rpc.handle("removeProcess", ({ id }: { id: string }) => editor.removeOwn(id));
  ctx.rpc.handle("trial", (input: Parameters<typeof editor.trial>[0]) => editor.trial(input));
  ctx.rpc.handle("trials", ({ id }: { id: string }) => editor.trials(id));
  ctx.rpc.handle("keepTrial", ({ taskId, keep }: { taskId: string; keep: boolean }) => editor.keepTrial(taskId, keep));
  ctx.rpc.handle("dropTrial", ({ taskId }: { taskId: string }) => editor.dropTrial(taskId));
  ctx.rpc.handle("sweepTrials", () => editor.sweepTrials());

  // Trials are forgotten after a day unless kept.
  let stopped = false;
  const sweep = setInterval(() => editor.sweepTrials(), 60 * 60_000);
  sweep.unref();
  setImmediate(() => !stopped && editor.sweepTrials());
  ctx.events.on("app.stopping", () => {
    stopped = true;
    clearInterval(sweep);
    changes.stopAll();
  });

  ctx.rpc.handle("trace", ({ taskId }: { taskId: string }) => ctx.processes.trace(taskId));
  ctx.rpc.handle("versions", ({ id }: { id: string }) => ctx.processes.versions(id));
  ctx.rpc.handle("draft", ({ id }: { id: string }) => ctx.kv.get<Draft>(`draft:${id}`) ?? null);
  ctx.rpc.handle("saveDraft", ({ id, spec }: { id: string; spec: ProcessSpec }) => editor.saveDraft(id, spec));
  ctx.rpc.handle("dropDraft", ({ id }: { id: string }) => void ctx.kv.set(`draft:${id}`, null));
  ctx.rpc.handle("preview", ({ id, spec }: { id: string; spec: ProcessSpec }) => editor.preview(id, spec));
  ctx.rpc.handle("apply", ({ id, spec, note }: { id: string; spec: ProcessSpec; note?: string }) => editor.apply(id, spec, note));
  ctx.rpc.handle("revert", ({ id }: { id: string }) => editor.revert(id));
  ctx.rpc.handle("upgrade", ({ taskId }: { taskId: string }) => ctx.processes.upgrade(taskId));
});

export function makeEditor(ctx: PluginContext) {
  const find = (id: string): ProcessInfo | undefined => ctx.processes.list().find((w) => w.id === id);
  /** The plugin a draft of the process is checked as: its own, or "my-processes" for a new one. */
  const pluginOf = (id: string) => find(id)?.plugin ?? MINE;

  return {
    saveDraft(id: string, spec: ProcessSpec): ProcessInfo {
      ctx.kv.set(`draft:${id}`, { spec, at: Date.now() } satisfies Draft);
      return this.preview(id, spec);
    },

    preview(id: string, spec: ProcessSpec): ProcessInfo {
      return ctx.processes.preview(pluginOf(id), spec);
    },

    /**
     * Saves the draft. The user's own process is rewritten; a plugin's gets the user's own version next to it,
     * which runs in its place: the plugin's file is never touched. Returns the id the process runs under.
     */
    apply(id: string, spec: ProcessSpec, note?: string): string {
      const def = find(id);
      let saved: ProcessSpec;
      if (!def) saved = qualify(spec, MINE, ctx.steps.list());
      else if (def.plugin === MINE) {
        saved = { ...qualify(spec, def.original?.plugin ?? MINE, ctx.steps.list()), id: def.spec.id };
        // A draft that took the original's changes in says so with the original's version as its base.
        const base = spec.base ?? def.spec.base;
        if (def.spec.overrides) saved = { ...saved, overrides: def.spec.overrides, ...(base ? { base } : {}) };
      } else {
        const short = id.slice(def.plugin.length + 1);
        saved = {
          ...qualify(spec, def.plugin, ctx.steps.list()),
          id: `${def.plugin}-${short}`,
          overrides: id,
          ...(def.version ? { base: def.version } : {}),
        };
      }
      const result = ctx.processes.save(MINE, saved, note?.trim() || undefined);
      ctx.kv.set(`draft:${id}`, null);
      return result;
    },

    /** A new process of the user's: its id made free among theirs. Returns the id it runs under. */
    create(spec: ProcessSpec): string {
      const taken = new Set(ctx.processes.list().filter((w) => w.plugin === MINE).map((w) => w.spec.id));
      const id = taken.has(spec.id) || !spec.id ? freeId(spec.label || spec.id, taken) : spec.id;
      return ctx.processes.save(MINE, qualify({ ...spec, id }, MINE, ctx.steps.list()), "created");
    },

    /** Deletes a process of the user's own; one that is used somewhere is not deleted. */
    removeOwn(id: string): void {
      const def = find(id);
      if (!def || def.plugin !== MINE || def.original) throw new Error("Only your own processes can be deleted");
      ctx.processes.remove(id);
      ctx.kv.set(`draft:${id}`, null);
    },

    /**
     * A trial run: a task of the process (its draft, when there is one) in the folder whose agent and settings it
     * uses, out of the tree's way; without consequences it skips the steps that change the world outside.
     */
    trial(input: { id: string; spec?: ProcessSpec; folderId: string; title: string; body?: string; dryRun: boolean; stepByStep: boolean }) {
      const def = find(input.id);
      const spec = input.spec && def && JSON.stringify(input.spec) !== JSON.stringify(def.spec) ? input.spec : undefined;
      return ctx.processes.createTask(
        { folderId: input.folderId, title: input.title || "Trial", body: input.body ?? "", meta: { [ctx.id]: { trial: input.id, draft: !!spec } } },
        input.id,
        { options: { trial: true, dryRun: input.dryRun, stepByStep: input.stepByStep }, spec },
      );
    },

    trials(id: string) {
      return ctx.tasks
        .list(undefined, { archived: "all" })
        .filter((t) => t.meta.trial && (t.meta[ctx.id] as { trial?: string } | undefined)?.trial === id)
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((t) => ({ ...t, run: ctx.processes.run(t.id) ?? null }));
    },

    keepTrial(taskId: string, keep: boolean): void {
      const task = ctx.tasks.get(taskId);
      if (!task?.meta.trial) return;
      ctx.tasks.update(taskId, { meta: { [ctx.id]: { ...(task.meta[ctx.id] as object), keep } } });
    },

    dropTrial(taskId: string): void {
      if (ctx.tasks.get(taskId)?.meta.trial) ctx.tasks.delete(taskId);
    },

    sweepTrials(): void {
      const day = Date.now() - 24 * 3600_000;
      for (const task of ctx.tasks.list(undefined, { archived: "all" })) {
        const own = task.meta[ctx.id] as { keep?: boolean } | undefined;
        if (task.meta.trial && !own?.keep && task.createdAt < day) ctx.tasks.delete(task.id);
      }
    },

    /** Drops the user's own version: the plugin's process runs again. It stays in the history. */
    revert(id: string): void {
      const def = find(id);
      if (!def?.original) throw new Error("This process is not your version of another one");
      ctx.processes.remove(id);
      ctx.kv.set(`draft:${id}`, null);
    },
  };
}

/** The issue that offers a process to the shared repository: what it is for, how it differs, the file. */
export function shareIssue(def: ProcessInfo, note?: string): { title: string; body: string } {
  const file = def.original ? `plugins/${def.original.plugin}/processes/${def.original.spec.id}.json` : `plugins/my-processes/processes/${def.spec.id}.json`;
  return {
    title: def.original ? `Process: a change to “${def.label}” (${def.id})` : `Process: “${def.label}”`,
    body: [
      def.original ? `A user's own version of the process \`${def.id}\` of the plugin ${def.original.plugin}, offered back (rule 8).` : `A process a user made, offered to everyone (rule 8).`,
      "",
      note?.trim() ? `In their words: ${note.trim()}` : "",
      def.description ? `What it does: ${def.description}` : "",
      "",
      `As ${file}:`,
      "",
      "```json",
      JSON.stringify({ ...def.spec, overrides: undefined, base: undefined }, null, 2),
      "```",
      "",
      "Made in the process editor (plugins/process-editor).",
    ]
      .filter((line, i, all) => line !== "" || all[i - 1] !== "")
      .join("\n"),
  };
}
