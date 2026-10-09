// What a plugin's ui.tsx imports: `import { defineUiPlugin, Button, rpc } from "#sdk/ui"`.
import type { Folder, Task } from "../sdk/types.ts";
import { api, getState, refresh, rpc, setState, useUi, onEvent, type Selection, type UiState } from "./api.ts";
import { t } from "./i18n.ts";
import { attempt, confirm } from "./kit/index.tsx";
import { archiveTasks, leavingTree, restoreTasks, tasksUnder } from "./archiveActions.ts";
import type { UiPlugin } from "./slots.tsx";

export type * from "../sdk/types.ts";
export type { Command, FolderCreateStep, PageProps, SlotName, SlotProps, TerminalHandle, UiPlugin } from "./slots.tsx";
export { allCommands } from "./commands.ts";
export { formatWhen, formatDateTime, statusLabel } from "./format.ts";
export type { KeyPress, Shortcut, ShortcutTarget } from "./shortcuts.ts";
export { formatKeys, shortcutHint } from "./shortcuts.ts";
export type { Selection, FolderTab, DetailsTab } from "./api.ts";
export { archiveTasks, confirmDeleteForever, leavingTree, restoreTasks, undoArchive, busyOf } from "./archiveActions.ts";
export { TaskTable, type TaskTableProps, type TaskRow } from "./components/TaskTable.tsx";
export * from "./kit/index.tsx";
export { TextArea, insertText, type FieldHandle } from "./TextArea.tsx";
export { addStrings, known, lang, t } from "./i18n.ts";
export { asksText, issueText, keyText, optionText, outcomeText, plural, questionText, stepText, processText } from "./processText.ts";
export { ProcessIcon, openNewFolderDialog, openOtherProcess } from "./components/FolderProcesses.tsx";
export { folderProcesses, folderList, SETTING as TASK_PROCESSES, MAX_BUTTONS } from "./folderProcesses.ts";
export { createTask } from "./taskActions.ts";
export { Terminal as AgentTerminal } from "./components/Terminal.tsx";
export { TaskView as TaskPanel } from "./components/TaskView.tsx";
export { Markdown } from "./markdown.tsx";
export { closeDetails, hideOutput, openDetails, showOutput, toggleDetails } from "./taskDetails.ts";
export { openAutomationDialog } from "./components/AutomationsView.tsx";
export { getState, onEvent, refresh, rpc, useUi };

export function defineUiPlugin(plugin: UiPlugin): UiPlugin {
  return plugin;
}

/** Shows a task, a folder or the settings in the main panel; null shows nothing. */
export function select(selection: Selection | null): void {
  const { data } = getState();
  const folderId =
    selection?.kind === "task"
      ? (data?.tasks.find((t) => t.id === selection.id)?.folderId ?? null)
      : selection?.kind === "folder"
        ? (data?.folders.find((f) => f.id === selection.id)?.parentId ?? null)
        : null;
  setState({ selection, collapsed: unfold(folderId) });
}

/** Opens a task in the main panel. */
export function selectTask(taskId: string | null): void {
  select(taskId ? { kind: "task", id: taskId } : null);
}

/** Opens a folder, with its settings, in the main panel. */
export function selectFolder(folderId: string): void {
  select({ kind: "folder", id: folderId });
}

/** Opens the app's settings in the main panel. */
export function openSettings(): void {
  select({ kind: "settings" });
}

/** Opens the archive: all of it, or a folder's with its subfolders. */
export function openArchive(folderId?: string): void {
  select(folderId ? { kind: "archive", folderId } : { kind: "archive" });
}

/** Opens an archived task, read only. */
export function openArchivedTask(taskId: string): void {
  select({ kind: "archived", id: taskId });
}

/** Opens the list of all automations. */
export function openAutomations(): void {
  select({ kind: "automations" });
}

/** Opens an automation's page: its trigger and its runs. */
export function selectAutomation(id: string): void {
  select({ kind: "automation", id });
}

/** Opens a page a plugin declared in `defineUiPlugin({ pages })`. */
export function openPage(plugin: string, page: string, params?: Record<string, unknown>): void {
  select({ kind: "page", plugin, page, params });
}

/** Unpicks the tasks picked in the tree. */
export function clearPicked(): void {
  if (getState().picked.length) setState({ picked: [] });
}

/** Restores an archived task by id and offers to open it. */
export async function restoreArchived(taskId: string): Promise<void> {
  const task = await attempt(() => api.get<Task | null>(`/api/tasks/${taskId}`));
  if (task?.archivedAt) await restoreTasks([task], { open: selectTask });
}

/** Opens a task wherever it is: in the tree, or in the archive. */
export async function openTask(taskId: string): Promise<void> {
  if (getState().data?.tasks.some((x) => x.id === taskId)) return selectTask(taskId);
  openArchivedTask(taskId);
}

/** The selected task, if a task is selected. */
export function useSelectedTask(): Task | undefined {
  return useUi((s) => (s.selection?.kind === "task" ? s.data?.tasks.find((t) => t.id === (s.selection as { id: string }).id) : undefined));
}

/** The selected folder, if a folder is selected. */
export function useSelectedFolder(): Folder | undefined {
  return useUi((s) =>
    s.selection?.kind === "folder" ? s.data?.folders.find((f) => f.id === (s.selection as { id: string }).id) : undefined,
  );
}

/** A setting's value for tasks in a folder (nearest folder that sets it, else the app value), or the app value. */
export function settingValue<T = unknown>(state: UiState, key: string, folderId?: string | null): T {
  const def = state.data?.settings.defs.find((d) => d.key === key);
  if (def?.folder) {
    for (let id = folderId ?? null; id; ) {
      const folder = state.data?.folders.find((f) => f.id === id);
      if (!folder) break;
      if (key in folder.settings) return folder.settings[key] as T;
      id = folder.parentId;
    }
  }
  return state.data?.settings.values[key]?.value as T;
}

/** Sets a setting for the app, or for a folder and its subfolders. */
export function setSetting(key: string, value: unknown, folderId?: string): Promise<unknown> {
  return folderId
    ? api.put(`/api/folders/${folderId}/settings/${encodeURIComponent(key)}`, { value })
    : api.put(`/api/settings/${encodeURIComponent(key)}`, { value });
}

/** Subscribes to a setting's value; see settingValue. */
export function useSetting<T = unknown>(key: string, folderId?: string | null): T {
  return useUi((s) => settingValue<T>(s, key, folderId));
}

/** Collapsed folders with this folder and the ones it is in unfolded. */
function unfold(folderId: string | null): Record<string, boolean> {
  const { data, collapsed } = getState();
  const open = { ...collapsed };
  while (folderId) {
    delete open[folderId];
    folderId = data?.folders.find((f) => f.id === folderId)?.parentId ?? null;
  }
  return open;
}

/** Turns a folder's or task's name in the tree into an input. */
export function startRename(id: string): void {
  const { data } = getState();
  const task = data?.tasks.find((t) => t.id === id);
  const parentId = task ? task.folderId : (data?.folders.find((f) => f.id === id)?.parentId ?? null);
  setState({ renaming: id, collapsed: unfold(parentId) });
}

/**
 * Deletes the folder with its subfolders; their tasks go to the archive. Asks first, unless the folder
 * is empty.
 */
export function confirmDeleteFolder(folder: Folder): void {
  const { data } = getState();
  const tasks = tasksUnder(folder).length;
  const automations = (data?.automations ?? []).filter((a) => a.folderId === folder.id).length;
  const subfolders = (data?.folders ?? []).some((f) => f.parentId === folder.id);
  const moveOn = leavingTree([folder.id]);
  const remove = () => void attempt(() => api.del(`/api/folders/${folder.id}`)).then((done) => done !== undefined && moveOn());
  if (!tasks && !subfolders && !automations) return remove();
  const parts = [tasks ? t("deleteFolderTasks", { n: tasks }) : "", automations ? t("deleteFolderAutomations", { n: automations }) : ""];
  confirm({
    title: t("deleteFolderTitle", { name: folder.name }),
    description: [...parts.filter(Boolean), t("deleteFolderBody")].join(" "),
    confirm: t("delete"),
    onConfirm: remove,
  });
}

/** Sends the task to the archive, with "Undo" in a toast; asks first when its agent works. */
export function confirmDeleteTask(task: Task): void {
  archiveTasks([task]);
}
