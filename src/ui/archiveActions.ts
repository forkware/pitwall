// Sending tasks to the archive and back, and deleting them for good: from menus, hotkeys and tables alike.
import type { Folder, Task } from "../sdk/types.ts";
import { api, getState, setState } from "./api.ts";
import { t } from "./i18n.ts";
import { attempt, confirm, toast } from "./kit/index.tsx";
import { isGone, successor, withSubfolders, type TreeItem } from "./tree.ts";

/** How long "Undo" (the toast's button, Ctrl+Z) can take an archiving back. */
export const UNDO_MS = 8000;

let last: { ids: string[]; at: number; dismiss: () => void } | null = null;

type Named = Pick<Task, "id" | "title">;

/** Tasks whose agent works or asks, or whose process runs a step: archiving stops them. */
export function busyOf(tasks: Named[]): Named[] {
  const { data } = getState();
  return tasks.filter(
    (task) =>
      data?.sessions.some((s) => s.taskId === task.id && s.state === "running" && (s.busy || s.asking)) ||
      data?.processes.runs.some((r) => r.taskId === task.id && r.state === "running"),
  );
}

/**
 * Sends tasks to the archive, with "Undo" in a toast. When an agent of one still works, asks first:
 * archiving stops it.
 */
export function archiveTasks(tasks: Named[]): void {
  if (tasks.length === 0) return;
  const busy = busyOf(tasks);
  const moveOn = leavingTree(tasks.map((x) => x.id));
  const go = () => void archiveNow(tasks).then((done) => done && moveOn());
  if (busy.length === 0) return go();
  confirm({
    title: busy.length === 1 ? t("archiveBusyOne", { name: busy[0].title }) : t("archiveBusyMany", { n: busy.length }),
    description: t("archiveBusyBody"),
    confirm: t("archiveStop"),
    onConfirm: go,
  });
}

async function archiveNow(tasks: Named[]): Promise<boolean> {
  const ids = tasks.map((x) => x.id);
  const done = await attempt(() => api.post("/api/tasks/archive", { ids }));
  if (done === undefined) return false;
  setState({ picked: getState().picked.filter((id) => !ids.includes(id)) });
  last?.dismiss();
  const text = tasks.length === 1 ? t("archivedOne", { name: tasks[0].title }) : t("archivedMany", { n: tasks.length });
  const dismiss = toast(text, "info", { action: { label: t("undo"), run: () => void undoArchive() }, duration: UNDO_MS });
  last = { ids, at: Date.now(), dismiss };
  return true;
}

/** Takes the last archiving back while its toast shows. Returns whether there was one. */
export function undoArchive(): boolean {
  if (!last || Date.now() - last.at > UNDO_MS) return false;
  const { ids, dismiss } = last;
  last = null;
  dismiss();
  void attempt(() => api.post("/api/tasks/restore", { ids }));
  return true;
}

/** Brings archived tasks back to the tree; one restored task can be opened from the toast. */
export async function restoreTasks(tasks: Named[], options: { open?: (id: string) => void } = {}): Promise<boolean> {
  if (tasks.length === 0) return false;
  const done = await attempt(() => api.post("/api/tasks/restore", { ids: tasks.map((x) => x.id) }));
  if (done === undefined) return false;
  if (tasks.length === 1) {
    const open = options.open;
    toast(t("restoredOne", { name: tasks[0].title }), "info", open ? { action: { label: t("open"), run: () => open(tasks[0].id) } } : {});
  } else toast(t("restoredMany", { n: tasks.length }));
  return true;
}

/** Asks, then deletes tasks for good with their sessions. */
export function confirmDeleteForever(tasks: Named[], onDone?: () => void): void {
  if (tasks.length === 0) return;
  const names = tasks.slice(0, 5).map((x) => `«${x.title}»`);
  const more = tasks.length > 5 ? ` ${t("andMore", { n: tasks.length - 5 })}` : "";
  const moveOn = leavingTree(tasks.map((x) => x.id));
  confirm({
    title: tasks.length === 1 ? t("deleteForeverOne", { name: tasks[0].title }) : t("deleteForeverMany", { n: tasks.length }),
    description: `${tasks.length > 1 ? `${names.join(", ")}${more}. ` : ""}${t("deleteForeverBody")}`,
    confirm: t("deleteForever"),
    onConfirm: async () => {
      const done = await attempt(() => api.post("/api/tasks/delete", { ids: tasks.map((x) => x.id) }));
      if (done === undefined) return;
      setState({ picked: getState().picked.filter((id) => !tasks.some((x) => x.id === id)) });
      moveOn();
      onDone?.();
    },
  });
}

/**
 * Call before tasks or folders leave the tree (archived, deleted): returns what to call once they left.
 * That moves the selection off them to the next row of the same section (see `successor`), so the panel
 * does not keep showing what left, and moves the focus with it when it was on a row that left or falls
 * off the page, so the next Del acts on the next row.
 */
export function leavingTree(ids: string[]): () => void {
  const { data, selection } = getState();
  if (!data) return () => {};
  const gone = new Set(ids);
  const focused = typeof document === "undefined" ? null : document.activeElement?.closest<HTMLElement>("[data-tree-id]");
  const focusedId = focused?.dataset.treeId;
  const selectedId = selection && (selection.kind === "task" || selection.kind === "folder") ? selection.id : undefined;
  const selectionGoes = !!selectedId && isGone(data, selectedId, gone);
  const focusGoes = !!focusedId && isGone(data, focusedId, gone);
  if (!selectionGoes && !focusGoes) return () => {};
  const target = successor(data, (selectionGoes ? selectedId : focusedId)!, gone);
  return () => {
    // The refresh may have shown the task in the archive already; a selection the user changed since stays.
    const now = getState().selection;
    if (selectionGoes && now && "id" in now && now.id === selectedId) {
      setState({ selection: target && { kind: target.kind, id: target.id } });
    }
    if (target && (focusGoes || selectionGoes)) focusRow(target, focusGoes);
  };
}

/**
 * Focuses the row in the tree; again a moment later, when a closing dialog gave the focus back to the
 * row that left. Without `force`, only when the focus is nowhere else.
 */
function focusRow(item: TreeItem, force: boolean): void {
  if (typeof document === "undefined") return;
  const tryFocus = () => {
    const active = document.activeElement;
    const lost = !active || active === document.body || !active.isConnected || isLeftRow(active);
    if (!force && !lost) return;
    document.querySelector<HTMLElement>(`[data-tree-id="${CSS.escape(item.id)}"]`)?.focus();
  };
  requestAnimationFrame(tryFocus);
  setTimeout(() => {
    const active = document.activeElement;
    if (!active || active === document.body || !active.isConnected || isLeftRow(active)) tryFocus();
  }, 250);
}

/** A tree row whose task or folder is no longer in the state. */
function isLeftRow(el: Element): boolean {
  const id = el.closest<HTMLElement>("[data-tree-id]")?.dataset.treeId;
  const { data } = getState();
  return !!id && !id.startsWith("automation:") && !data?.tasks.some((x) => x.id === id) && !data?.folders.some((f) => f.id === id);
}

/** The folder's tasks in the tree, its subfolders' too. */
export function tasksUnder(folder: Folder): Task[] {
  const { data } = getState();
  const ids = withSubfolders({ folders: data?.folders ?? [] }, [folder.id]);
  return (data?.tasks ?? []).filter((x) => ids.has(x.folderId) && !x.meta?.trial);
}

/** The done tasks of a folder and its subfolders. */
export function doneUnder(folder: Folder): Task[] {
  const { data } = getState();
  const done = new Set(data?.statuses.filter((s) => s.category === "done").map((s) => s.id));
  return tasksUnder(folder).filter((x) => done.has(x.status));
}
