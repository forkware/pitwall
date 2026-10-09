// Steps made in words: each Markdown file in plugins/my-processes/steps/ is a step for an agent, registered as
// "prompt-steps.<file name>". Also the stand-in for a step an agent is still making in code.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { basename, join } from "node:path";
import { definePlugin, type PluginContext, type Task } from "#sdk/server";
import { fillPrompt, insertedKeys, parseStep, pickOption, writeStep, type PromptStep } from "./files.ts";

export default definePlugin((ctx) => {
  makePromptSteps(ctx, join(ctx.app.root, "plugins", "my-processes", "steps"));
});

export function makePromptSteps(ctx: PluginContext, dir: string) {
  const loaded = new Map<string, PromptStep>();
  const workspace = (task: Task) => task.workspace ?? ctx.workspaces.ofFolder(task.id);
  const running = (taskId: string) => ctx.agents.sessions(taskId).filter((s) => s.state === "running").at(-1);

  const register = (step: PromptStep) => {
    const reads = insertedKeys(step.prompt).map((k) => `${k}?`);
    const text = `${step.key}.text`;
    const choice = `${step.key}.choice`;
    ctx.steps.register({
      id: step.name,
      label: step.label,
      description: step.description || (step.mode === "terminal" ? "Gives the agent this task in the task's terminal." : "An agent answers this."),
      icon: step.mode === "terminal" ? "bot" : "sparkles",
      group: "agent",
      role: "agent",
      reads,
      writes: step.mode === "answer" ? [text, ...(step.options.length ? [choice] : [])] : [],
      labels: { [text]: `the answer of “${step.label}”`, [choice]: `what “${step.label}” decided` },
      outcomes: step.options.length ? { [choice]: Object.fromEntries(step.options.map((o) => [o, o])) } : undefined,
      questions:
        step.mode === "terminal"
          ? [{ id: "agent", kind: "choice", title: "The agent is working", options: [{ id: "done", label: "The agent finished" }], when: "when the agent does not say it is done" }]
          : undefined,
      run: async ({ task, state, ask, progress }) => {
        const prompt = fillPrompt(step.prompt, task, state);
        if (step.mode === "terminal") {
          const mark = `given:${task.id}`;
          if (!ctx.kv.get(mark)) {
            progress("Giving the task to the agent");
            const session = running(task.id);
            if (session) ctx.agents.send(session.id, prompt);
            else ctx.agents.start(task.id, { prompt: `${prompt}\n\nWhen you finish, run: pitwall finished "<what you did>"` });
            ctx.kv.set(mark, true);
          }
          ask({ kind: "choice", id: "agent", title: "The agent is working", options: [{ id: "done", label: "The agent finished" }] });
          ctx.kv.set(mark, null);
          return;
        }
        progress("The agent is thinking");
        const answer = await ctx.agents.run(
          step.options.length ? `${prompt}\n\nAnswer with exactly one of these on the first line, then why: ${step.options.join(" | ")}` : prompt,
          { folderId: task.folderId, cwd: workspace(task), fallback: "session" },
        );
        return { [text]: answer, ...(step.options.length ? { [choice]: pickOption(answer, step.options) ?? null } : {}) };
      },
    });
    loaded.set(step.name, step);
  };

  /** Reads the files again: new and changed steps register, deleted ones go. */
  const load = () => {
    const seen = new Set<string>();
    if (existsSync(dir)) {
      for (const file of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
        const name = basename(file, ".md");
        try {
          const step = parseStep(name, readFileSync(join(dir, file), "utf8"));
          seen.add(name);
          if (JSON.stringify(loaded.get(name)) !== JSON.stringify(step)) register(step);
        } catch (error) {
          ctx.log(`${file} is not a step:`, (error as Error).message);
        }
      }
    }
    for (const name of [...loaded.keys()]) {
      if (!seen.has(name)) {
        loaded.delete(name);
        ctx.steps.remove(name);
      }
    }
  };
  load();
  let watcher: FSWatcher | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watchDir = () => {
    if (watcher || !existsSync(dir)) return;
    try {
      watcher = watch(dir, () => {
        clearTimeout(timer);
        timer = setTimeout(load, 150);
      });
      watcher.unref();
    } catch {}
  };
  watchDir();

  // A step an agent is still making in code: it holds the place in a process, which cannot run until it is replaced.
  ctx.steps.register({
    id: "pending",
    label: "A step being made",
    description: "Holds the place of a step an agent is making in code; replace it with the step when it is ready.",
    icon: "hammer",
    group: "other",
    params: {
      description: { type: "text", label: "What the step should do" },
      task: { type: "string", label: "The task making it" },
    },
    blocked: (params) => {
      const task = typeof params.task === "string" ? ctx.tasks.get(params.task) : undefined;
      return task ? `the step is being made in “${task.title}”` : "the step is being made";
    },
    run: () => {
      throw new Error("This step is still being made: replace it with the step when it is ready");
    },
  });

  const save = (input: Omit<PromptStep, "name"> & { name?: string }): string => {
    const name =
      input.name ||
      input.label
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) ||
      "step";
    let free = name;
    if (!input.name) for (let i = 2; existsSync(join(dir, `${free}.md`)); i++) free = `${name}-${i}`;
    const step = parseStep(free, writeStep({ ...input, name: free, key: input.key || free }));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${free}.md`), writeStep(step));
    register(step);
    watchDir();
    return `${ctx.id}.${free}`;
  };

  ctx.rpc.handle("list", () => [...loaded.values()]);
  ctx.rpc.handle("save", (input: Parameters<typeof save>[0]) => save(input));
  ctx.rpc.handle("remove", ({ name }: { name: string }) => {
    rmSync(join(dir, `${name}.md`), { force: true });
    loaded.delete(name);
    ctx.steps.remove(name);
  });
  // "Try it on a task": the answer an agent gives to the prompt there, not touching the task's process.
  ctx.rpc.handle("try", async ({ taskId, prompt, options }: { taskId: string; prompt: string; options?: string[] }) => {
    const task = ctx.tasks.get(taskId);
    if (!task) throw new Error("No such task");
    const filled = fillPrompt(prompt, task, {});
    const answer = await ctx.agents.run(
      options?.length ? `${filled}\n\nAnswer with exactly one of these on the first line, then why: ${options.join(" | ")}` : filled,
      { folderId: task.folderId, cwd: workspace(task), fallback: "session" },
    );
    return { answer, choice: options?.length ? (pickOption(answer, options) ?? null) : null };
  });

  const stop = () => {
    clearTimeout(timer);
    watcher?.close();
  };
  ctx.events.on("app.stopping", stop);
  return { load, save, stop };
}
