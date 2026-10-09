import {
  archiveTasks,
  clearPicked,
  confirmDeleteFolder,
  confirmDeleteForever,
  defineUiPlugin,
  getState,
  restoreArchived,
  startRename,
  undoArchive,
  type Shortcut,
  type Task,
} from "#sdk/ui";

// Delete on Mac keyboards is Backspace; Cmd+Backspace deletes, as in Finder.
const del = ["Delete", "Mod+Backspace"];
const delForever = ["Shift+Delete", "Mod+Shift+Backspace"];

/** The picked tasks when the target is one of them, else the target alone. */
function targets(task: Task): Task[] {
  const { picked, data } = getState();
  if (!picked.includes(task.id)) return [task];
  return (data?.tasks ?? []).filter((x) => picked.includes(x.id));
}

export const shortcuts: Shortcut[] = [
  { command: "rename", keys: "F2", scope: "task", run: (task) => startRename(task.id) },
  { command: "rename", keys: "F2", scope: "folder", run: (folder) => startRename(folder.id) },
  // A task goes to the archive, with Undo; it is deleted for good from there, or with Shift.
  { command: "archive", keys: del, scope: "task", run: (task) => archiveTasks(targets(task)) },
  { command: "deleteForever", keys: delForever, scope: "task", run: (task) => confirmDeleteForever(targets(task)) },
  { command: "delete", keys: del, scope: "folder", run: confirmDeleteFolder },
  { command: "undo", keys: "Mod+Z", run: () => void undoArchive() },
  {
    command: "restore",
    keys: "Shift+U",
    run: () => {
      const { selection } = getState();
      if (selection?.kind === "archived") void restoreArchived(selection.id);
    },
  },
  { command: "clearPick", keys: "Escape", run: clearPicked },
];

export default defineUiPlugin({ shortcuts });
