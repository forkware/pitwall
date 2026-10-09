// Steps anyone can build a process from: ask for the task, ask me a question, give the agent a task, let an agent
// answer or decide, run a command, name a note. Each describes itself for the process editor.
import { exec } from "node:child_process";
import { definePlugin, type QuestionInfo, type Task } from "#sdk/server";
import { fill, options as parseOptions } from "./text.ts";

/** The keys these steps write, and what templates may insert. */
const KEYS = ["choice.answer", "agent.answer", "agent.choice", "command.passed", "command.output"] as const;
const OPTIONAL_READS = KEYS.map((k) => `${k}?`);

export default definePlugin((ctx) => {
  const workspace = (task: Task) => task.workspace ?? ctx.workspaces.ofFolder(task.id);
  const running = (taskId: string) => ctx.agents.sessions(taskId).filter((s) => s.state === "running").at(-1);

  ctx.steps.register({
    id: "describe",
    label: "Describe the task",
    description: "Asks you for the task's name and description, and names the task with them.",
    icon: "pencil-line",
    group: "you",
    params: {
      question: { type: "string", label: "Question", default: "What is the task?" },
      body: { type: "boolean", label: "Ask for a description too", default: true },
    },
    questions: (p) => [
      {
        id: "main",
        kind: "form",
        title: String(p.question ?? "What is the task?"),
        fields: [{ id: "title", label: "Title", required: true }, ...(p.body === false ? [] : [{ id: "body", label: "Description" }])],
      },
    ],
    run: ({ ask, setTask, params }) => {
      const answer = ask<{ title: string; body?: string }>({
        kind: "form",
        id: "main",
        title: String(params.question || "What is the task?"),
        fields: [
          { id: "title", label: "Title", required: true },
          ...(params.body === false ? [] : [{ id: "body", label: "Description", multiline: true }]),
        ],
        submit: "Create",
      });
      setTask({ title: answer.title.trim(), ...(answer.body !== undefined ? { body: answer.body.trim() } : {}) });
    },
  });

  ctx.steps.register({
    id: "ask",
    label: "Ask me",
    description: "Asks you a question with buttons; the process can go a different way for each answer.",
    icon: "message-circle-question",
    group: "you",
    params: {
      question: { type: "string", label: "Question", default: "Is it done?", required: true },
      details: { type: "text", label: "Details under the question" },
      options: {
        type: "text",
        label: "Answers, one per line",
        description: "“Done → done” also moves the task to that status.",
        default: "Done\nOnce more",
        required: true,
      },
    },
    writes: ["choice.answer"],
    labels: { "choice.answer": "your answer" },
    questions: (p): QuestionInfo[] => [
      { id: "main", kind: "choice", title: String(p.question ?? ""), options: parseOptions(String(p.options ?? "")) },
    ],
    outcomes: (p) => ({ "choice.answer": Object.fromEntries(parseOptions(String(p.options ?? "")).map((o) => [o.id, o.label])) }),
    run: ({ ask, params }) => {
      const choices = parseOptions(String(params.options ?? ""));
      if (!choices.length) throw new Error("The question has no answers: add them in the step's card");
      const answer = ask<string>({
        kind: "choice",
        id: "main",
        title: String(params.question || "?"),
        ...(params.details ? { body: String(params.details) } : {}),
        options: choices.map((o, i) => ({ ...o, primary: i === 0 })),
      });
      return { "choice.answer": answer };
    },
  });

  ctx.steps.register({
    id: "agent-task",
    label: "Task for the agent",
    description: "Gives the folder's agent a task in the task's terminal and waits until it says it is done.",
    icon: "bot",
    group: "agent",
    role: "agent",
    reads: OPTIONAL_READS,
    params: {
      prompt: {
        type: "prompt",
        label: "What the agent should do",
        default: "{{task.title}}\n\n{{task.body}}",
        required: true,
      },
      wait: { type: "boolean", label: "Wait until it says it is done", default: true },
    },
    questions: [
      {
        id: "agent",
        kind: "choice",
        title: "The agent is working",
        options: [{ id: "done", label: "The agent finished" }],
        when: "when the agent does not say it is done",
      },
    ],
    run: ({ task, state, params, ask, progress }) => {
      const prompt = fill(String(params.prompt ?? ""), task, state);
      // After the user's answer the step runs again from its start: the task was given already. A new visit of the
      // step (the process came back to it) gives it again: the mark goes when the step ends.
      const mark = `given:${task.id}`;
      if (!ctx.kv.get(mark)) {
        progress("Giving the task to the agent");
        const session = running(task.id);
        if (session) ctx.agents.send(session.id, prompt);
        else ctx.agents.start(task.id, { prompt: `${prompt}\n\nWhen you finish, run: pitwall finished "<what you did>"` });
        if (params.wait !== false) ctx.kv.set(mark, true);
      }
      if (params.wait !== false) {
        ask({
          kind: "choice",
          id: "agent",
          title: "The agent is working",
          body: "It runs `pitwall finished` when it is done; if it does not, press the button.",
          options: [{ id: "done", label: "The agent finished" }],
        });
        ctx.kv.set(mark, null);
      }
    },
  });

  ctx.steps.register({
    id: "agent-answer",
    label: "An agent answers",
    description: "An agent answers a question without a terminal; with answers to pick from, it decides which way the process goes.",
    icon: "sparkles",
    group: "agent",
    role: "agent",
    reads: OPTIONAL_READS,
    writes: ["agent.answer", "agent.choice"],
    labels: { "agent.answer": "the agent's answer", "agent.choice": "what the agent decided" },
    params: {
      prompt: { type: "prompt", label: "What to ask the agent", default: "{{task.title}}\n\n{{task.body}}", required: true },
      options: {
        type: "text",
        label: "Answers it picks from, one per line",
        description: "Empty: it answers in its own words. With answers, the process can go a different way for each.",
      },
    },
    outcomes: (p) => ({ "agent.choice": Object.fromEntries(parseOptions(String(p.options ?? "")).map((o) => [o.id, o.label])) }),
    run: async ({ task, state, params, progress }) => {
      const choices = parseOptions(String(params.options ?? ""));
      const question = fill(String(params.prompt ?? ""), task, state);
      const prompt = choices.length
        ? `${question}\n\nAnswer with exactly one of these, on the first line, then why: ${choices.map((o) => o.id).join(" | ")}`
        : question;
      progress("The agent is thinking");
      const answer = await ctx.agents.run(prompt, { folderId: task.folderId, cwd: workspace(task), fallback: "session" });
      const first = answer.split("\n").find((l) => l.trim())?.trim().toLowerCase() ?? "";
      const picked = choices.find((o) => first === o.id.toLowerCase()) ?? choices.find((o) => first.includes(o.id.toLowerCase()));
      return { "agent.answer": answer, "agent.choice": picked?.id ?? null };
    },
  });

  ctx.steps.register({
    id: "command",
    label: "Run a command",
    description: "Runs a command in the task's directory, like the tests; the process can go on differently when it fails.",
    icon: "square-terminal",
    group: "tests",
    writes: ["command.passed", "command.output"],
    labels: { "command.passed": "whether the command passed", "command.output": "what the command printed" },
    outcomes: { "command.passed": { true: "passed", false: "failed" } },
    params: {
      command: { type: "string", label: "Command", placeholder: "pnpm test", default: "pnpm test", required: true },
      minutes: { type: "number", label: "Stop it after, minutes", default: 10 },
    },
    run: async ({ task, params, progress }) => {
      const command = String(params.command ?? "").trim();
      progress(`Running ${command}`);
      const { code, output } = await new Promise<{ code: number; output: string }>((resolve) => {
        exec(
          command,
          { cwd: workspace(task), timeout: Number(params.minutes || 10) * 60_000, maxBuffer: 8 * 1024 * 1024 },
          (error, stdout, stderr) => resolve({ code: error ? Number((error as { code?: number }).code ?? 1) || 1 : 0, output: `${stdout}${stderr}` }),
        );
      });
      return { "command.passed": code === 0, "command.output": output.slice(-4000) };
    },
  });

  ctx.steps.register({
    id: "note",
    label: "Name it after the time",
    description: "Names the task after the date and time: a note to write in later.",
    icon: "calendar-clock",
    run: ({ setTask }) => {
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      setTask({ title: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}` });
    },
  });

  // The agent says the task a step gave it is done: any step waiting for its agent asks with the id "agent"
  // (this plugin's "Task for the agent", the prompt steps).
  ctx.agents.onSignal({
    name: "finished",
    description: '"<what you did>": the task the process gave you is done; the process goes on',
    handler: ({ task }) => {
      const run = ctx.processes.run(task.id);
      if (run?.state !== "waiting" || run.request?.id !== "agent") return "Nothing waits for that now.";
      ctx.processes.resume(task.id, "done");
      return "Thanks: the process goes on.";
    },
  });
});
