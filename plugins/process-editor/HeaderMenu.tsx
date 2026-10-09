// The "…" of a process's page: make a copy, offer it to the shared repository, delete it.
import { Copy, MoreHorizontal, Share2, Trash2 } from "lucide-react";
import { useState } from "react";
import {
  Button,
  Dialog,
  IconButton,
  Input,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  rpc,
  showCustomDialog,
  t,
  toast,
  processText,
  type ProcessInfo,
} from "#sdk/ui";
import { MINE_PLUGIN } from "./ids.ts";
import { copyAsMine, deleteProcess } from "./NewProcess.tsx";

export function HeaderMenu({ def }: { def: ProcessInfo }) {
  const mine = def.plugin === MINE_PLUGIN;
  return (
    <Menu>
      <MenuTrigger asChild>
        <IconButton icon={MoreHorizontal} label={processText(def)} className="size-7" />
      </MenuTrigger>
      <MenuContent align="end">
        <MenuItem icon={Copy} onSelect={() => void copyAsMine(def, t("we.copyOf", { name: processText(def) }))}>
          {t("we.copy")}
        </MenuItem>
        {mine && (
          <MenuItem icon={Share2} onSelect={() => openShare(def)}>
            {t("we.share.title")}
          </MenuItem>
        )}
        {mine && !def.original && (
          <>
            <MenuSeparator />
            <MenuItem icon={Trash2} danger onSelect={() => deleteProcess(def)}>
              {t("delete")}
            </MenuItem>
          </>
        )}
      </MenuContent>
    </Menu>
  );
}

function openShare(def: ProcessInfo): void {
  showCustomDialog(({ open, onOpenChange }) => <Share def={def} open={open} onOpenChange={onOpenChange} />);
}

/** Confirms before anything leaves the user's machine: it is a public issue in the app's repository. */
function Share({ def, open, onOpenChange }: { def: ProcessInfo; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t("we.share.title")} description={t("we.share.body")}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            const url = await rpc<string>("process-editor", "share", { id: def.id, note });
            onOpenChange(false);
            toast(t("we.share.done"), "info", { action: { label: t("we.open"), run: () => window.open(url, "_blank") }, duration: 15000 });
          } catch (error) {
            toast(t("we.share.failed", { error: (error as Error).message }), "error");
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="block">
          <span className="mb-1 block text-xs text-muted">{t("we.share.why")}</span>
          <Input autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("we.share.whyHint")} />
        </label>
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            {t("cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {t("we.share.send")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
