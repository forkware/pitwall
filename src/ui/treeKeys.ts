// Keyboard and mouse in the sidebar's tree: which row the arrows go to, the right click's menu,
// and who keeps the focus when a row opens a task.
import type { AppState } from "../sdk/types.ts";
import { getState } from "./api.ts";
import { selectAutomation, selectFolder, selectTask } from "./sdk.tsx";

/** The row an arrow goes to from `current`, among the rows shown in order; undefined at the ends. */
export function adjacentRow(ids: string[], current: string, key: string): string | undefined {
  const delta = key === "ArrowDown" ? 1 : key === "ArrowUp" ? -1 : 0;
  const at = ids.indexOf(current);
  if (!delta || at < 0) return undefined;
  return ids[at + delta];
}

/** What a row opens, as a click on it would, without folding or unfolding a folder. */
export function rowSelection(id: string, data: Pick<AppState, "tasks" | "folders"> | null | undefined) {
  if (id.startsWith("automation:")) return { kind: "automation" as const, id: id.slice("automation:".length) };
  if (data?.tasks.some((t) => t.id === id)) return { kind: "task" as const, id };
  if (data?.folders.some((f) => f.id === id)) return { kind: "folder" as const, id };
  return undefined;
}

export function openRow(id: string): void {
  const s = rowSelection(id, getState().data);
  if (s?.kind === "task") selectTask(s.id);
  else if (s?.kind === "folder") selectFolder(s.id);
  else if (s?.kind === "automation") selectAutomation(s.id);
}

/**
 * The open task's row is in focus: the task was opened from the tree with a click or an arrow,
 * so its terminal and its form leave the focus there, and Del or the arrows act on the row at once.
 */
export function treeKeepsFocus(
  active: Element | null = globalThis.document?.activeElement ?? null,
  selection = getState().selection,
): boolean {
  const id = (active as HTMLElement | null)?.dataset?.treeId;
  return !!id && selection?.kind === "task" && selection.id === id;
}

interface RowEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  currentTarget: HTMLElement;
  preventDefault(): void;
}

/** Up and Down on a row in focus: the focus and the selection go to the row above or below. */
export function rowArrow(e: RowEvent): boolean {
  if ((e.key !== "ArrowDown" && e.key !== "ArrowUp") || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return false;
  e.preventDefault();
  const rows = [...(e.currentTarget.closest('[role="tree"]')?.querySelectorAll<HTMLElement>("[data-tree-id]") ?? [])];
  const next = adjacentRow(
    rows.map((row) => row.dataset.treeId!),
    e.currentTarget.dataset.treeId!,
    e.key,
  );
  if (!next) return false;
  rows.find((row) => row.dataset.treeId === next)?.focus();
  openRow(next);
  return true;
}

/** A right click on a row opens its menu; in a name being renamed it keeps the browser's own, with Paste. */
export function rowContextMenu(e: { target: EventTarget | null; preventDefault(): void }, open: () => void): void {
  if ((e.target as HTMLElement | null)?.closest?.("input, textarea")) return;
  e.preventDefault();
  open();
}


/** A right click on the tree's empty space, not on a row, a button or a field: it opens the tree's menu. */
export function onTreeSpace(target: EventTarget | null): boolean {
  return !(target as HTMLElement | null)?.closest?.("[data-tree-id], button, a, input, textarea");
}
