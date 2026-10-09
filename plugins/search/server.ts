import { definePlugin, type Task } from "#sdk/server";
import { SearchIndex, type SearchInput } from "./search.ts";

export default definePlugin((ctx) => {
  const index = new SearchIndex(ctx);
  index.rebuild();
  const put = (task: Task) => {
    const now = ctx.tasks.get(task.id);
    if (now) index.put(now);
  };
  for (const name of ["task.created", "task.updated", "task.archived", "task.restored"]) ctx.events.on(name, put);
  ctx.events.on("task.status.changed", ({ task }) => put(task));
  ctx.events.on("task.deleted", (task: Task) => index.remove(task.id));
  // A renamed or moved folder changes the paths of its tasks.
  for (const name of ["folder.updated", "folder.restored"]) ctx.events.on(name, () => index.rebuild());

  ctx.rpc.handle("search", (input: SearchInput) => index.search(input ?? {}));
});
