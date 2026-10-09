// Running a process by hand from its page: a button in a folder (its "Task buttons"), or one task now.
import { useState } from "react";
import {
  Button,
  createTask,
  Dialog,
  folderList,
  getState,
  MAX_BUTTONS,
  openAutomationDialog,
  setSetting,
  showCustomDialog,
  t,
  TASK_PROCESSES,
  toast,
  processText,
  type ProcessInfo,
} from "#sdk/ui";
import { Select } from "./EditCard.tsx";
import { useFolderOptions } from "./Trials.tsx";

export function openAddToFolder(def: ProcessInfo): void {
  showCustomDialog(({ open, onOpenChange }) => <AddToFolder def={def} open={open} onOpenChange={onOpenChange} />);
}

function AddToFolder({ def, open, onOpenChange }: { def: ProcessInfo; open: boolean; onOpenChange: (open: boolean) => void }) {
  const folders = useFolderOptions();
  const [folderId, setFolderId] = useState(folders[0]?.value ?? "");
  const list = folderList(getState().data, folderId || null);
  const has = list.some((x) => x.process === def.id);
  const full = list.length >= MAX_BUTTONS;
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t("we.folder.addTitle")} description={processText(def)}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!folderId || has) return;
          try {
            await setSetting(TASK_PROCESSES, [...list, { process: def.id }], folderId);
            onOpenChange(false);
            toast(t("we.folder.added", { folder: folders.find((f) => f.value === folderId)?.label ?? "" }));
          } catch (error) {
            toast((error as Error).message, "error");
          }
        }}
      >
        {folders.length ? (
          <Select label={t("we.folder.which")} value={folderId} onChange={setFolderId} options={folders} />
        ) : (
          <p className="text-muted">{t("we.folder.none")}</p>
        )}
        <p className="mt-2 text-xs text-muted">
          {has ? t("we.folder.already") : full ? t("we.folder.full", { n: list.length }) : t("we.folder.count", { n: list.length })}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            {t("cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={!folderId || has}>
            {t("we.folder.add")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function openCreateTask(def: ProcessInfo): void {
  showCustomDialog(({ open, onOpenChange }) => <CreateTask def={def} open={open} onOpenChange={onOpenChange} />);
}

function CreateTask({ def, open, onOpenChange }: { def: ProcessInfo; open: boolean; onOpenChange: (open: boolean) => void }) {
  const folders = useFolderOptions();
  const [folderId, setFolderId] = useState(folders[0]?.value ?? "");
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t("we.folder.createTitle")} description={processText(def)}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!folderId) return;
          onOpenChange(false);
          void createTask(folderId, def.id);
        }}
      >
        {folders.length ? (
          <Select label={t("we.folder.which")} value={folderId} onChange={setFolderId} options={folders} />
        ) : (
          <p className="text-muted">{t("we.folder.none")}</p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            {t("cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={!folderId || def.problems.length > 0}>
            {t("we.folder.create")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** "Run it automatically…": the folder its tasks go to, then the automation with this process picked. */
export function openAutomate(def: ProcessInfo): void {
  showCustomDialog(({ open, onOpenChange }) => <Automate def={def} open={open} onOpenChange={onOpenChange} />);
}

function Automate({ def, open, onOpenChange }: { def: ProcessInfo; open: boolean; onOpenChange: (open: boolean) => void }) {
  const folders = useFolderOptions();
  const [folderId, setFolderId] = useState(folders[0]?.value ?? "");
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t("we.folder.automateTitle")} description={t("we.folder.automateBody")}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const folder = getState().data?.folders.find((f) => f.id === folderId);
          if (!folder) return;
          onOpenChange(false);
          openAutomationDialog(folder, undefined, { process: def.id });
        }}
      >
        {folders.length ? (
          <Select label={t("we.folder.which")} value={folderId} onChange={setFolderId} options={folders} />
        ) : (
          <p className="text-muted">{t("we.folder.none")}</p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            {t("cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={!folderId || def.problems.length > 0}>
            {t("we.folder.next")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
