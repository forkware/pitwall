// Making a task from the tree, a menu or a hotkey: plainly, or with a process that takes it from there.
import type { Task } from "../sdk/types.ts";
import { api, getState, setState } from "./api.ts";
import { t } from "./i18n.ts";
import { attempt } from "./kit/index.tsx";
import { selectTask, startRename } from "./sdk.tsx";

/**
 * Without a process the new task's name turns into an input, as before. With one, the task opens and
 * the process names it: its first step usually asks for the task in a form under the header.
 */
export async function createTask(folderId: string, process?: string): Promise<Task | undefined> {
  const task = await attempt(() => api.post<Task>("/api/tasks", { folderId, title: t("newTask"), process }));
  if (!task) return undefined;
  setState({ collapsed: { ...getState().collapsed, [folderId]: false } });
  if (process) selectTask(task.id);
  else startRename(task.id);
  return task;
}
