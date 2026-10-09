// Example processes (as files in processes/): a creation form, an agent, a question that moves the status, a process with no questions.
import { definePlugin } from "#sdk/server";

export default definePlugin((ctx) => {
  // The task's creation screen: the first step asks for it, then names the task.
  ctx.steps.register({
    id: "describe",
    label: "Describe the task",
    icon: "pencil-line",
    group: "you",
    questions: [
      {
        id: "main",
        kind: "form",
        title: "What is the task?",
        fields: [
          { id: "title", label: "Title", required: true },
          { id: "body", label: "Description" },
        ],
      },
    ],
    run: ({ ask, setTask }) => {
      const answer = ask<{ title: string; body?: string }>({
        kind: "form",
        title: "What is the task?",
        fields: [
          { id: "title", label: "Title", required: true },
          { id: "body", label: "Description", multiline: true, placeholder: "What should be done, and how to check it" },
        ],
        submit: "Create",
      });
      setTask({ title: answer.title.trim(), body: answer.body?.trim() ?? "" });
    },
  });

  ctx.steps.register({
    id: "agent",
    label: "Start the agent",
    description: "Starts the folder's agent with the task's title and description.",
    icon: "bot",
    group: "agent",
    role: "agent",
    run: ({ task, progress }) => {
      progress("Starting the folder's agent");
      ctx.agents.start(task.id, { prompt: [task.title, task.body].filter(Boolean).join("\n\n") });
    },
  });

  ctx.steps.register({
    id: "review",
    label: "Review",
    icon: "user-round-check",
    group: "you",
    questions: [{ id: "main", kind: "choice", title: "Is it done?", options: [{ id: "done", label: "Done", status: "done" }] }],
    // Work goes on outside the process, in the agent's terminal: the only answer is Done.
    run: ({ ask }) => {
      ask({ kind: "choice", title: "Is it done?", options: [{ id: "done", label: "Done", primary: true, status: "done" }] });
    },
  });

  // A task with no creation screen: the step names it at once.
  ctx.steps.register({
    id: "note",
    label: "Name the note",
    description: "Names the task after the date and time.",
    icon: "calendar-clock",
    run: ({ setTask }) => {
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      setTask({ title: `Note ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}` });
    },
  });

  // The processes themselves are data: processes/agent.json and processes/note.json.
});
