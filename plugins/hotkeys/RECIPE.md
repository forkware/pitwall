# Hotkeys

## Intent

Rename, archive and delete tasks and folders from the keyboard, the way a file manager does (issue #3). Since the archive (issue #38), Delete no longer deletes a task: it sends it to the archive at once, and Undo takes it back; deleting for good is Shift+Delete, after asking. Other plugins add their own keys the same way.

## Spec

- The target is the tree row in focus (clicking a row focuses it). With nothing in focus, the open task.
- `F2` on a task or folder: its name in the tree turns into an input; Enter saves, Escape cancels; the focus stays on the row.
- `Delete` (or `Cmd/Ctrl+Backspace`) on a task: to the archive without asking, with "Undo" in a toast for 8 seconds. When its agent works or asks, or its process runs a step, it asks first: archiving stops them. When the task is one of the tasks picked in the tree (Ctrl/Shift+click), all picked tasks go.
- `Ctrl/Cmd+Z` (outside fields): takes the last archiving back while its toast shows.
- `Shift+Delete` (or `Cmd/Ctrl+Shift+Backspace`) on a task: deletes it for good (and the other picked ones), after asking.
- `Delete` on a folder: asks, then deletes it; its tasks go to the archive. An empty folder goes without asking.
- `Shift+U` on an archived task's page: restores it.
- `Escape`: unpicks the picked tasks.
- Menus show the keys next to "Rename", "Archive", "Delete forever" and the folder's "Delete", taken from these shortcuts' `command` (`rename`, `archive`, `deleteForever`, `delete`).
- Keys do nothing while typing in a field or the terminal, and while a menu or dialog is open.

The core parts: `UiPlugin.shortcuts` (`src/ui/shortcuts.ts`); `archiveTasks`, `undoArchive`, `confirmDeleteForever`, `restoreArchived`, `clearPicked`, `startRename`, `confirmDeleteFolder` in `#sdk/ui`; `UiState.picked`.

## Check

`pnpm test` runs `tests/hotkeys.test.ts`: F2 renames, Delete archives at once and Ctrl+Z restores, Delete takes all picked tasks, Shift+Delete deletes only on confirm, a folder asks first, keys are ignored in inputs, the menu hints. By hand: click a task, press Delete, then Undo in the toast; press Shift+Delete and confirm.
