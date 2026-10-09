# New folder from the tree

## Intent

A right click in the empty space of the folder tree should offer to create a new folder (issue #53).

## Spec

- A right click on the tree's free area (below the last row, between nothing and nothing: not on a folder, a task, an automation or a button) shows the app's menu at the pointer, with one item, "New folder".
- The item opens the usual New folder dialog, for a folder at the top level.
- A right click on a folder or a task opens its own menu, as before; in a name being renamed the browser's menu stays.

The core part: the `tree.menu` slot (`src/ui/slots.tsx`), opened by `Sidebar` when `onTreeSpace(target)` (`src/ui/treeKeys.ts`) and some plugin fills it; `openNewFolderDialog` in `#sdk/ui`.

## Check

`pnpm test` runs `tests/tree-new-folder.test.ts`: the plugin fills `tree.menu`, its item opens the dialog for the top level, and `onTreeSpace` tells empty space from rows. By hand: right click below the last row, pick "New folder", create one and see it in the tree; right click a folder and a task: their menus open.
