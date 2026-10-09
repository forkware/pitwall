import { FolderPlus } from "lucide-react";
import { defineUiPlugin, MenuItem, openNewFolderDialog, t } from "#sdk/ui";

/** In the menu of the tree's empty space: a folder at the top level, with the usual dialog. */
export function NewFolderItem() {
  return (
    <MenuItem icon={FolderPlus} onSelect={() => openNewFolderDialog(null)}>
      {t("newFolder")}
    </MenuItem>
  );
}

export default defineUiPlugin({ slots: { "tree.menu": NewFolderItem } });
