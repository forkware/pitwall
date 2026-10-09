// A new process: from a template, in words, or empty — one window with the three ways, templates first.
import { Sparkles } from "lucide-react";
import { useState } from "react";
import {
  Button,
  confirm,
  Dialog,
  getState,
  Input,
  known,
  prompt,
  rpc,
  showCustomDialog,
  t,
  toast,
  ProcessIcon,
  processText,
  type ProcessInfo,
} from "#sdk/ui";
import { emptySpec, fromTemplate } from "./build.ts";
import { openProcess } from "./Catalog.tsx";
import { MINE_PLUGIN } from "./ids.ts";
import { usedAnywhere, usesOf } from "./model.ts";

const words = (key: string) => (known(key) ? t(key) : undefined);

/** Makes the user's own process and opens it, in the edit mode, or with the words for the agent. */
async function create(spec: Parameters<typeof fromTemplate>[0] | ReturnType<typeof emptySpec>, open: Record<string, unknown>): Promise<void> {
  try {
    const id = await rpc<string>("process-editor", "create", { spec });
    openProcess(id, open);
  } catch (error) {
    toast((error as Error).message, "error");
  }
}

/** A copy of a process (a template, or any) as the user's own, in their language. */
export function copyAsMine(w: ProcessInfo, label = processText(w)): Promise<void> {
  const spec = fromTemplate({ ...w.spec, full: w.id }, w.spec.id, label, words);
  return create({ ...spec, ...(w.description ? { description: processText(w, "description") } : {}) }, { edit: true });
}

export function openNewProcess(focusWords = false): void {
  showCustomDialog(({ open, onOpenChange }) => <NewProcess focusWords={focusWords} open={open} onOpenChange={onOpenChange} />);
}

function NewProcess({ focusWords, open, onOpenChange }: { focusWords: boolean; open: boolean; onOpenChange: (open: boolean) => void }) {
  const templates = (getState().data?.processes.defs ?? []).filter((w) => w.template);
  const [request, setRequest] = useState("");
  const close = () => onOpenChange(false);
  return (
    <Dialog open={open} onOpenChange={onOpenChange} wide title={t("we.new.title")} description={t("we.catalogHint")}>
      {templates.length > 0 && (
        <section className="mb-4">
          <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-faint">{t("we.new.fromTemplate")}</h3>
          <ul className="grid gap-1.5 sm:grid-cols-2">
            {templates.map((w) => (
              <li key={w.id}>
                <button
                  onClick={() => (close(), void copyAsMine(w))}
                  className="flex h-full w-full items-start gap-2 rounded-md border border-line px-2.5 py-2 text-left hover:border-accent focus-visible:border-accent focus-visible:outline-none"
                >
                  <ProcessIcon name={w.icon} size={14} className="mt-0.5 shrink-0 text-muted" />
                  <span className="min-w-0">
                    <span className="block font-medium">{processText(w)}</span>
                    <span className="block text-xs text-muted">{processText(w, "description")}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!request.trim()) return;
          close();
          // Named by the first words of the request until the agent or the user names it better.
          const words = request.trim().split(/\s+/).slice(0, 6).join(" ");
          void create(emptySpec("process", words.length > 48 ? `${words.slice(0, 47)}…` : words), { request: request.trim(), change: Date.now() });
        }}
      >
        <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-faint">{t("we.new.inWords")}</h3>
        <div className="flex gap-2">
          <Input autoFocus={focusWords || !templates.length} value={request} onChange={(e) => setRequest(e.target.value)} placeholder={t("we.new.wordsHint")} />
          <Button type="submit" variant="primary" icon={Sparkles} disabled={!request.trim()}>
            {t("we.new.describe")}
          </Button>
        </div>
      </form>
      <div className="mt-4 flex items-center justify-between">
        <button
          className="text-xs text-muted hover:text-text hover:underline"
          onClick={() => {
            close();
            prompt({
              title: t("we.new.nameTitle"),
              initial: t("we.new.name"),
              onSubmit: (label) => create(emptySpec("process", label.trim() || t("we.new.name")), { edit: true }),
            });
          }}
        >
          {t("we.new.empty")}
        </button>
        <Button variant="ghost" onClick={close}>
          {t("cancel")}
        </Button>
      </div>
    </Dialog>
  );
}

/** Deletes a process of the user's own, after asking; one that is used somewhere says where first. */
export function deleteProcess(w: ProcessInfo): void {
  if (w.plugin !== MINE_PLUGIN || w.original) return;
  if (usedAnywhere(usesOf(getState().data, w.id))) {
    toast(t("we.delete.used"), "error", { action: { label: t("we.open"), run: () => openProcess(w.id) } });
    return;
  }
  confirm({
    title: t("we.delete.title", { name: processText(w) }),
    description: t("we.delete.body"),
    confirm: t("delete"),
    onConfirm: () => void rpc("process-editor", "removeProcess", { id: w.id }).catch((error) => toast((error as Error).message, "error")),
  });
}
