// The customization process as a LangGraph graph. For now it has one step, running the agent;
// review, tests and an issue in the fork become nodes of the same graph later.
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import type { PluginContext } from "#sdk/server";

const State = Annotation.Root({
  taskId: Annotation<string>,
  sessionId: Annotation<string | undefined>,
  /** What the user wants, when another plugin already knows it (e.g. "install Whisper"). */
  request: Annotation<string | undefined>,
});

export function customizeProcess(ctx: PluginContext) {
  return new StateGraph(State)
    .addNode("runAgent", ({ taskId, request }) => ({
      sessionId: ctx.agents.start(taskId, { prompt: prompt(ctx, request) }).id,
    }))
    .addEdge(START, "runAgent")
    .addEdge("runAgent", END)
    .compile();
}

function prompt(ctx: PluginContext, request?: string): string {
  return [
    `You are in the source code of "${ctx.app.name}", the app this terminal runs in. It is a Forkware app: read forkware/manifesto.md and CLAUDE.md first.`,
    request
      ? `The app started you for the user with this request:\n\n${request}\n\nDo it; ask the user only what you cannot decide yourself. When it changes the app's code:`
      : "The user pressed \"Customize the app\". Ask them what they want to change, then:",
    "1. Open an issue for it in this repository with `gh issue create` (rule 2).",
    "2. Make the change as a plugin in plugins/ when the core allows it, with a RECIPE.md and tests (rules 3-5).",
    "3. Run `pnpm test` and `pnpm run check`.",
    "4. Tell the user how to see the result. UI changes reload by themselves. Server changes need the app restarted: ask the user to do it, do not restart it yourself, it runs this session.",
  ].join("\n");
}
