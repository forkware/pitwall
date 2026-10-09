// What the catalog offers besides its cards: "New", "Describe in words", the cards' menus, the steps tab.
import { Copy, ListPlus, Play, Plus, Repeat, Sparkles, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { Button, MenuItem, MenuSeparator, t, type ProcessInfo } from "#sdk/ui";
import { deleteProcess, openNewProcess, copyAsMine } from "./NewProcess.tsx";
import { openAddToFolder, openAutomate, openCreateTask } from "./FolderActions.tsx";
import { MINE_PLUGIN } from "./ids.ts";

export const catalogExtras = {
  actions: (): ReactNode => (
    <>
      <Button size="sm" variant="ghost" icon={Sparkles} onClick={() => openNewProcess(true)}>
        <span className="hidden sm:inline">{t("we.new.inWordsShort")}</span>
      </Button>
      <Button size="sm" variant="primary" icon={Plus} onClick={() => openNewProcess()}>
        {t("we.new.button")}
      </Button>
    </>
  ),
  empty: (): ReactNode => (
    <Button variant="primary" icon={Plus} onClick={() => openNewProcess()}>
      {t("we.new.button")}
    </Button>
  ),
};

export function cardMenuExtras(w: ProcessInfo): ReactNode {
  return (
    <>
      <MenuItem icon={Play} onSelect={() => openCreateTask(w)}>
        {t("we.folder.createTitle")}
      </MenuItem>
      <MenuItem icon={ListPlus} onSelect={() => openAddToFolder(w)}>
        {t("we.folder.addTitle")}
      </MenuItem>
      <MenuItem icon={Repeat} onSelect={() => openAutomate(w)}>
        {t("we.folder.automateTitle")}
      </MenuItem>
      <MenuItem icon={Copy} onSelect={() => void copyAsMine(w, t("we.copyOf", { name: w.label }))}>
        {t("we.copy")}
      </MenuItem>
      {w.plugin === MINE_PLUGIN && !w.original && (
        <>
          <MenuSeparator />
          <MenuItem icon={Trash2} danger onSelect={() => deleteProcess(w)}>
            {t("delete")}
          </MenuItem>
        </>
      )}
    </>
  );
}

export { StepsLibrary as StepsTab } from "./StepsLibrary.tsx";
