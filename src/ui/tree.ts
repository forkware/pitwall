// The tree's order, as the sidebar draws it, and where the selection goes when rows leave it.
import type { AppState, Automation, Task } from "../sdk/types.ts";

/** A folder's tasks as the tree shows them: open ones, the ones under each automation's node, then the done ones. */
export interface FolderSections {
  open: Task[];
  groups: { automation: Automation; tasks: Task[] }[];
  done: Task[];
}

/**
 * Splits a folder's tasks into the tree's sections. `needs` are tasks that wait for the user: they show
 * in the folder even when their automation keeps its tasks under its node.
 */
export function folderSections(tasks: Task[], doneStatuses: Set<string>, automations: Automation[], needs: Set<string>): FolderSections {
  const owner = (task: Task) => automations.find((a) => a.id === (task.meta.automation as { id?: string } | undefined)?.id);
  const grouped = (task: Task) => {
    const a = owner(task);
    return !!a && a.view !== "folder" && !needs.has(task.id);
  };
  return {
    open: tasks.filter((x) => !grouped(x) && !doneStatuses.has(x.status)),
    groups: automations.map((automation) => ({ automation, tasks: tasks.filter((x) => grouped(x) && owner(x) === automation) })),
    done: tasks.filter((x) => !grouped(x) && doneStatuses.has(x.status)),
  };
}

type TreeData = Pick<AppState, "folders" | "tasks" | "statuses" | "automations" | "processes" | "sessions">;

/** Tasks that wait for the user: a process's question or error, an agent's prompt. */
export function needingUser(data: Pick<AppState, "processes" | "sessions">): Set<string> {
  const ids = new Set<string>();
  for (const r of data.processes.runs) if (r.state === "waiting" || r.state === "failed") ids.add(r.taskId);
  for (const x of data.sessions) if (x.asking) ids.add(x.taskId);
  return ids;
}

/** The folder's tasks in the tree, by section; a process editor's trial runs stay out of it. */
export function sectionsOf(data: TreeData, folderId: string): FolderSections {
  const done = new Set(data.statuses.filter((s) => s.category === "done").map((s) => s.id));
  const tasks = data.tasks.filter((x) => x.folderId === folderId && !x.meta?.trial);
  return folderSections(tasks, done, data.automations.filter((a) => a.folderId === folderId), needingUser(data));
}

/** The ids of these folders and every folder under them. */
export function withSubfolders(data: Pick<AppState, "folders">, ids: Iterable<string>): Set<string> {
  const all = new Set(ids);
  for (let grew = true; grew; ) {
    grew = false;
    for (const f of data.folders) if (f.parentId && all.has(f.parentId) && !all.has(f.id)) (all.add(f.id), (grew = true));
  }
  return all;
}

export type TreeItem = { kind: "task" | "folder"; id: string };

/** The nearest item after `index` that stays, else the nearest before it. */
function neighbour<T extends { id: string }>(items: T[], index: number, gone: (item: T) => boolean): T | undefined {
  return items.slice(index + 1).find((x) => !gone(x)) ?? items.slice(0, index).reverse().find((x) => !gone(x));
}

/**
 * Where the selection goes when the row `id` leaves the tree with the rows `gone` (tasks and folders;
 * a folder takes its subfolders and their tasks along): the next task of the same section, else the one
 * above, else the folder. For a folder: the next folder beside it, else the one above, else its parent.
 */
export function successor(data: TreeData, id: string, gone: Set<string>): TreeItem | null {
  const folders = withSubfolders(data, [...gone].filter((x) => data.folders.some((f) => f.id === x)));
  const task = data.tasks.find((x) => x.id === id);
  if (task && !folders.has(task.folderId)) {
    const sections = sectionsOf(data, task.folderId);
    for (const section of [sections.open, ...sections.groups.map((g) => g.tasks), sections.done]) {
      const index = section.findIndex((x) => x.id === id);
      if (index < 0) continue;
      const next = neighbour(section, index, (x) => gone.has(x.id));
      if (next) return { kind: "task", id: next.id };
    }
    return { kind: "folder", id: task.folderId };
  }
  // The topmost folder that goes: its neighbours stay.
  let folder = data.folders.find((f) => f.id === (task ? task.folderId : id));
  while (folder?.parentId && folders.has(folder.parentId)) folder = data.folders.find((f) => f.id === folder!.parentId);
  if (!folder) return null;
  const siblings = data.folders.filter((f) => f.parentId === folder!.parentId);
  const next = neighbour(siblings, siblings.indexOf(folder), (f) => folders.has(f.id));
  if (next) return { kind: "folder", id: next.id };
  return folder.parentId ? { kind: "folder", id: folder.parentId } : null;
}

/** Whether the row `id` (a task or a folder) leaves the tree with the rows `gone`. */
export function isGone(data: Pick<AppState, "folders" | "tasks">, id: string, gone: Set<string>): boolean {
  if (gone.has(id)) return true;
  const folders = withSubfolders(data, [...gone].filter((x) => data.folders.some((f) => f.id === x)));
  const task = data.tasks.find((x) => x.id === id);
  return folders.has(task ? task.folderId : id);
}
