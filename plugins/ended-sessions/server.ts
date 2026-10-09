// What to do with an agent that ended: continue it in its tab (the core restores a removed directory through
// the plugins that can), or start a new one that gets the task's description.
import { definePlugin, type Task } from "#sdk/server";

/** The first message of a new agent for the task: what the task is. */
export function freshPrompt(task: Task): string {
  const body = task.body.trim();
  return body && body !== task.title ? `${task.title}\n\n${body}` : task.title;
}

export default definePlugin((ctx) => {
  const ended = (sessionId: string) => {
    const session = ctx.agents.sessions().find((s) => s.id === sessionId);
    if (!session) throw new Error("This agent is gone");
    return session;
  };

  ctx.rpc.handle("continuation", ({ sessionId }: { sessionId: string }) => ctx.agents.continuation(sessionId));

  ctx.rpc.handle("continue", ({ sessionId }: { sessionId: string }) => ctx.agents.continue(ended(sessionId).id));

  ctx.rpc.handle("fresh", ({ sessionId }: { sessionId: string }) => {
    const session = ended(sessionId);
    const task = ctx.tasks.get(session.taskId);
    if (!task) throw new Error("The task is gone");
    return ctx.agents.start(task.id, { provider: session.provider, prompt: freshPrompt(task) });
  });
});
