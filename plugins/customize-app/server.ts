import { definePlugin } from "#sdk/server";
import { customizeProcess } from "./process.ts";

export default definePlugin((ctx) => {
  const process = customizeProcess(ctx);

  // Before the rename this plugin was "improve-app": take over the folder it made.
  if (!ctx.kv.get("folderId")) {
    const old = ctx.folders.list().find((f) => (f.meta["improve-app"] as { app?: boolean } | undefined)?.app);
    if (old) {
      ctx.folders.update(old.id, { meta: { [ctx.id]: { app: true } } });
      ctx.kv.set("folderId", old.id);
    }
  }

  /** The folder named after the app, created on first use. */
  const appFolder = () => {
    const known = ctx.kv.get<string>("folderId");
    const existing = known ? ctx.folders.get(known) : undefined;
    if (existing) return existing;
    const folder = ctx.folders.create({ name: ctx.app.name, meta: { [ctx.id]: { app: true } } });
    ctx.kv.set("folderId", folder.id);
    return folder;
  };

  // Agents for tasks in that folder work on the app's own code.
  ctx.workspaces.registerResolver((_task, folders) => {
    const id = ctx.kv.get<string>("folderId");
    return folders.some((f) => f.id === id) ? ctx.app.root : undefined;
  });

  /**
   * `title` comes from the UI, in the user's language. `request` is what the user wants when another
   * plugin already knows it (voice-input asks to install Whisper): the agent starts on it instead of asking.
   */
  ctx.rpc.handle("start", async ({ title = "Customization", request }: { title?: string; request?: string }) => {
    const folder = appFolder();
    const count = ctx.tasks.list(folder.id).length;
    const task = ctx.tasks.create({ folderId: folder.id, title: `${title} ${count + 1}` });
    const { sessionId } = await process.invoke({ taskId: task.id, request });
    return { folderId: folder.id, taskId: task.id, sessionId };
  });
});
