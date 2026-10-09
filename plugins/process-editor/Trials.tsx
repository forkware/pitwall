// Trial runs: a process (or its draft) tried on a task that stays out of the tree, without consequences if asked,
// step by step if asked. The "Trials" tab shows them with the task's own panel and what each step got and gave.
import { FlaskConical, Pin, PinOff, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import {
  Button,
  cx,
  Dialog,
  formatDateTime,
  getState,
  IconButton,
  Input,
  keyText,
  onEvent,
  rpc,
  showCustomDialog,
  t,
  TaskPanel,
  TextArea,
  toast,
  useUi,
  type Task,
  type ProcessInfo,
  type ProcessRun,
  type ProcessSpec,
} from "#sdk/ui";
import { fieldClass, Select } from "./EditCard.tsx";
import { useTrace, entryWords } from "./WhyHere.tsx";
import { usesOf } from "./model.ts";

type Trial = Task & { run: ProcessRun | null };

/** Folders by their path, for picking one: "Work / Client". */
export function useFolderOptions(): { value: string; label: string }[] {
  const folders = useUi((s) => s.data?.folders ?? []);
  const path = (id: string | null): string => {
    const f = folders.find((x) => x.id === id);
    return f ? (f.parentId ? `${path(f.parentId)} / ${f.name}` : f.name) : "";
  };
  return folders.map((f) => ({ value: f.id, label: path(f.id) })).sort((a, b) => a.label.localeCompare(b.label));
}

export function openTrial(def: ProcessInfo, spec: ProcessSpec, onStarted: (taskId: string) => void): void {
  showCustomDialog(({ open, onOpenChange }) => (
    <TrialDialog def={def} spec={spec} onStarted={onStarted} open={open} onOpenChange={onOpenChange} />
  ));
}

function TrialDialog({
  def,
  spec,
  onStarted,
  open,
  onOpenChange,
}: {
  def: ProcessInfo;
  spec: ProcessSpec;
  onStarted: (taskId: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const folders = useFolderOptions();
  const first = usesOf(getState().data, def.id).folders[0] ?? folders[0]?.value ?? "";
  const [folderId, setFolderId] = useState(first);
  const [dryRun, setDryRun] = useState(true);
  const [stepByStep, setStepByStep] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const draft = JSON.stringify(spec) !== JSON.stringify(def.spec);
  return (
    <Dialog open={open} onOpenChange={onOpenChange} wide title={t("we.trial.title")} description={draft ? t("we.trial.ofDraft") : t("we.trial.body")}>
      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!folderId) return;
          setBusy(true);
          try {
            const task = await rpc<Task>("process-editor", "trial", { id: def.id, spec, folderId, title: title || t("we.trial.task"), body, dryRun, stepByStep });
            onOpenChange(false);
            onStarted(task.id);
          } catch (error) {
            toast((error as Error).message, "error");
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="flex items-start gap-2">
          <input type="checkbox" className="mt-0.5 size-3.5 accent-[var(--accent)]" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
          <span>
            {t("we.trial.dry")}
            <span className="block text-xs text-muted">{t("we.trial.dryHint")}</span>
          </span>
        </label>
        <label className="flex items-start gap-2">
          <input type="checkbox" className="mt-0.5 size-3.5 accent-[var(--accent)]" checked={stepByStep} onChange={(e) => setStepByStep(e.target.checked)} />
          <span>
            {t("we.trial.steps")}
            <span className="block text-xs text-muted">{t("we.trial.stepsHint")}</span>
          </span>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-muted">{t("we.trial.folder")}</span>
          {folders.length ? (
            <Select label={t("we.trial.folder")} value={folderId} onChange={setFolderId} options={folders} />
          ) : (
            <span className="text-[var(--danger)]">{t("we.trial.noFolder")}</span>
          )}
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-muted">{t("we.trial.taskTitle")}</span>
          <Input className="h-8" value={title} placeholder={t("we.trial.task")} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-muted">{t("we.trial.taskBody")}</span>
          <TextArea rows={3} className={fieldClass} value={body} onChange={(e) => setBody(e.target.value)} />
        </label>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            {t("cancel")}
          </Button>
          <Button type="submit" variant="primary" icon={FlaskConical} disabled={busy || !folderId}>
            {t("we.trial.start")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function useTrials(id: string): Trial[] {
  const [trials, setTrials] = useState<Trial[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => void rpc<Trial[]>("process-editor", "trials", { id }).then((x) => alive && setTrials(x)).catch(() => {});
    load();
    const off = onEvent((name) => (name.startsWith("task.") || name === "process.updated") && load());
    return () => {
      alive = false;
      off();
    };
  }, [id]);
  return trials;
}

export function TrialsTab({ def, picked, onPick, onNew }: { def: ProcessInfo; picked?: string; onPick: (taskId: string) => void; onNew: () => void }) {
  const trials = useTrials(def.id);
  const shown = trials.find((x) => x.id === picked) ?? trials[0];
  const live = useUi((s) => s.data?.tasks.find((x) => x.id === shown?.id));
  if (!trials.length) {
    return (
      <div className="px-6 py-5">
        <p className="mb-3 max-w-2xl text-muted">{t("we.trial.none")}</p>
        <Button icon={FlaskConical} onClick={onNew}>
          {t("we.trial.title")}
        </Button>
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
      <aside className="shrink-0 overflow-y-auto border-b border-line p-3 lg:w-72 lg:border-b-0 lg:border-r">
        <ul className="space-y-0.5">
          {trials.map((x) => (
            <li key={x.id}>
              <button
                onClick={() => onPick(x.id)}
                className={cx("w-full rounded-md px-2 py-1.5 text-left", x.id === shown?.id ? "bg-hover" : "hover:bg-hover/60")}
              >
                <span className="block truncate">{x.title}</span>
                <span className="block text-[11px] text-faint">
                  {formatDateTime(x.createdAt)} · {t(`we.trial.state.${x.run?.state ?? "done"}`)}
                  {(x.meta["process-editor"] as { draft?: boolean } | undefined)?.draft ? ` · ${t("we.trial.draft")}` : ""}
                  {x.run?.options.dryRun ? ` · ${t("we.trial.dryShort")}` : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <Button size="sm" variant="ghost" icon={FlaskConical} className="mt-2" onClick={onNew}>
          {t("we.trial.again")}
        </Button>
      </aside>
      {shown && (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-2 border-b border-line px-4 py-2 text-xs">
            <span className="text-muted">{t("we.trial.keepHint")}</span>
            <span className="ml-auto flex items-center gap-1">
              {(shown.meta["process-editor"] as { keep?: boolean } | undefined)?.keep ? (
                <Button size="sm" variant="ghost" icon={PinOff} onClick={() => void rpc("process-editor", "keepTrial", { taskId: shown.id, keep: false })}>
                  {t("we.trial.unkeep")}
                </Button>
              ) : (
                <Button size="sm" variant="ghost" icon={Pin} onClick={() => void rpc("process-editor", "keepTrial", { taskId: shown.id, keep: true })}>
                  {t("we.trial.keep")}
                </Button>
              )}
              <IconButton icon={Trash2} label={t("we.trial.drop")} onClick={() => void rpc("process-editor", "dropTrial", { taskId: shown.id })} />
            </span>
          </div>
          <div className="flex min-h-0 flex-1 flex-col xl:flex-row">
            <div className="relative min-h-[320px] min-w-0 flex-1">{live ? <TaskPanel task={live} /> : null}</div>
            <section className="shrink-0 overflow-y-auto border-t border-line p-3 xl:w-80 xl:border-l xl:border-t-0">
              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-faint">{t("we.trial.what")}</h3>
              <TrialTrace taskId={shown.id} process={def.id} />
            </section>
          </div>
        </div>
      )}
    </div>
  );
}

/** Each step of a trial: its result in words, and what it gave, key by key. */
function TrialTrace({ taskId, process }: { taskId: string; process: string }) {
  const trace = useTrace(taskId);
  const defs = useUi((s) => s.data?.processes.defs ?? []);
  const steps = useUi((s) => s.data?.processes.steps ?? []);
  if (!trace.length) return <p className="text-muted">{t("we.pathEmpty")}</p>;
  return (
    <ol className="space-y-2">
      {trace.map((entry) => {
        const { name, result } = entryWords(entry, defs, steps, process);
        const gave = Object.entries(entry.output ?? {});
        return (
          <li key={entry.seq} className="text-xs">
            <div>
              <span className="font-medium">{name}</span> <span className="text-muted">— {result}</span>
            </div>
            {entry.result === "skipped" && entry.error && <div className="text-faint">{entry.error === "a trial without consequences" ? t("we.trial.skippedDry") : entry.error}</div>}
            {gave.length > 0 && (
              <ul className="mt-0.5 space-y-0.5 text-muted">
                {gave.map(([key, value]) => (
                  <li key={key} className="truncate" title={typeof value === "string" ? value : JSON.stringify(value)}>
                    <span className="text-faint">{keyText(key, steps)}:</span> {typeof value === "string" ? value : JSON.stringify(value)}
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ol>
  );
}
