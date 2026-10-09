// "New step in words": a step for an agent with no code — what it should do, how it works, what it gives back —
// tried on a task before it is made. It is kept as a Markdown file (plugins/my-processes/steps), by prompt-steps.
import { FlaskConical } from "lucide-react";
import { useRef, useState } from "react";
import {
  Button,
  cx,
  Dialog,
  getState,
  Input,
  insertText,
  keyText,
  rpc,
  showCustomDialog,
  t,
  TextArea,
  toast,
  useUi,
  type ProcessSpec,
} from "#sdk/ui";
import { fieldClass, Select } from "./EditCard.tsx";
import { asNode } from "./specs.ts";

/** A step made in words, as prompt-steps keeps it. */
export interface PromptStepInfo {
  name: string;
  label: string;
  description: string;
  mode: "answer" | "terminal";
  key: string;
  options: string[];
  prompt: string;
}

/** What a prompt can insert: the task's title and description, and what the process's steps make. */
function slots(spec?: ProcessSpec): string[] {
  const steps = getState().data?.processes.steps ?? [];
  const keys = new Set<string>(["task.title", "task.body"]);
  const from = spec ? Object.values(spec.nodes).map((n) => asNode(n).step) : ["basic-steps.agent-answer", "basic-steps.ask", "basic-steps.command"];
  for (const id of from) for (const k of steps.find((s) => s.id === id)?.writes ?? []) keys.add(k);
  return [...keys];
}

export function openNewStep(options: { name?: string; existing?: PromptStepInfo; spec?: ProcessSpec; onCreated?: (stepId: string) => void }): void {
  showCustomDialog(({ open, onOpenChange }) => <NewStep {...options} open={open} onOpenChange={onOpenChange} />);
}

function NewStep({
  name,
  existing,
  spec,
  onCreated,
  open,
  onOpenChange,
}: {
  name?: string;
  existing?: PromptStepInfo;
  spec?: ProcessSpec;
  onCreated?: (stepId: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const steps = useUi((s) => s.data?.processes.steps ?? []);
  const tasks = useUi((s) => (s.data?.tasks ?? []).filter((x) => !x.meta?.trial));
  const [label, setLabel] = useState(existing?.label ?? name ?? "");
  const [prompt, setPrompt] = useState(existing?.prompt ?? "");
  const [mode, setMode] = useState<"answer" | "terminal">(existing?.mode ?? "terminal");
  const [key, setKey] = useState(existing?.key ?? "");
  const [choosing, setChoosing] = useState(!!existing?.options.length);
  const [options, setOptions] = useState(existing?.options.join(", ") ?? "");
  const [tryTask, setTryTask] = useState(tasks[0]?.id ?? "");
  const [tried, setTried] = useState<{ answer: string; choice: string | null } | null>(null);
  const [busy, setBusy] = useState<"try" | "save" | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const picks = choosing
    ? options
        .split(",")
        .map((o) => o.trim())
        .filter(Boolean)
    : [];
  const insert = (slot: string) => {
    const el = field.current;
    if (!el) return setPrompt((p) => `${p}{{${slot}}}`);
    insertText(el, `{{${slot}}}`);
    setPrompt(el.value);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} wide title={existing ? t("we.newStep.edit") : t("we.newStep.title")} description={t("we.newStep.body")}>
      <form
        className="max-h-[70vh] space-y-3 overflow-y-auto pr-1"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!label.trim() || !prompt.trim()) return;
          setBusy("save");
          try {
            const id = await rpc<string>("prompt-steps", "save", {
              name: existing?.name,
              label: label.trim(),
              description: "",
              mode,
              key: key.trim(),
              options: mode === "answer" ? picks : [],
              prompt,
            });
            onOpenChange(false);
            onCreated?.(id);
            toast(existing ? t("we.newStep.saved") : t("we.newStep.created", { name: label.trim() }));
          } catch (error) {
            toast((error as Error).message, "error");
          } finally {
            setBusy(null);
          }
        }}
      >
        <label className="block">
          <span className="mb-1 block text-xs text-muted">{t("we.newStep.name")}</span>
          <Input autoFocus className="h-8" value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t("we.newStep.nameHint")} />
        </label>
        <div>
          <span className="mb-1 block text-xs text-muted">{t("we.newStep.prompt")}</span>
          <TextArea ref={field} rows={6} className={cx(fieldClass, "resize-y")} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={t("we.newStep.promptHint")} />
          <div className="mt-1 flex flex-wrap items-center gap-1 text-xs">
            <span className="text-faint">{t("we.newStep.insert")}</span>
            {slots(spec).map((slot) => (
              <button
                key={slot}
                type="button"
                onClick={() => insert(slot)}
                className="rounded border border-line px-1.5 py-px text-muted hover:border-accent hover:text-text"
                title={`{{${slot}}}`}
              >
                {slot === "task.title" ? t("we.newStep.title_") : slot === "task.body" ? t("we.newStep.body_") : keyText(slot, steps)}
              </button>
            ))}
          </div>
        </div>
        <fieldset className="space-y-1">
          <legend className="mb-1 text-xs text-muted">{t("we.newStep.how")}</legend>
          <label className="flex items-start gap-2">
            <input type="radio" className="mt-1 accent-[var(--accent)]" checked={mode === "terminal"} onChange={() => setMode("terminal")} />
            <span>{t("we.newStep.terminal")}</span>
          </label>
          <label className="flex items-start gap-2">
            <input type="radio" className="mt-1 accent-[var(--accent)]" checked={mode === "answer"} onChange={() => setMode("answer")} />
            <span>
              {t("we.newStep.answer")}
              <span className="block text-xs text-muted">{t("we.newStep.answerHint")}</span>
            </span>
          </label>
        </fieldset>
        {mode === "answer" && (
          <fieldset className="space-y-1.5">
            <legend className="mb-1 text-xs text-muted">{t("we.newStep.gives")}</legend>
            <label className="flex items-center gap-2">
              <span className="w-40 shrink-0">{t("we.newStep.text")}</span>
              <Input className="h-8" value={key} onChange={(e) => setKey(e.target.value)} placeholder={t("we.newStep.keyHint")} />
            </label>
            <label className="flex items-start gap-2">
              <input type="checkbox" className="mt-1 size-3.5 accent-[var(--accent)]" checked={choosing} onChange={(e) => setChoosing(e.target.checked)} />
              <span className="min-w-0 flex-1">
                {t("we.newStep.choice")}
                {choosing && <Input className="mt-1 h-8" value={options} onChange={(e) => setOptions(e.target.value)} placeholder={t("we.newStep.choiceHint")} />}
                <span className="block text-xs text-muted">{t("we.newStep.choiceBranch")}</span>
              </span>
            </label>
          </fieldset>
        )}
        {mode === "answer" && tasks.length > 0 && (
          <div className="rounded-md border border-line p-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted">{t("we.newStep.tryOn")}</span>
              <Select
                label={t("we.newStep.tryOn")}
                value={tryTask}
                onChange={setTryTask}
                options={tasks.map((x) => ({ value: x.id, label: x.title }))}
                className="w-auto min-w-40 flex-1"
              />
              <Button
                type="button"
                size="sm"
                icon={FlaskConical}
                disabled={!prompt.trim() || busy !== null}
                onClick={async () => {
                  setBusy("try");
                  setTried(null);
                  try {
                    setTried(await rpc("prompt-steps", "try", { taskId: tryTask, prompt, options: picks }));
                  } catch (error) {
                    toast((error as Error).message, "error");
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                {busy === "try" ? t("we.change.thinking") : t("we.newStep.try")}
              </Button>
            </div>
            {tried && (
              <div className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-bg p-2 text-xs">
                {tried.choice !== null && <div className="mb-1 font-medium">{t("we.newStep.picked", { choice: tried.choice })}</div>}
                {tried.answer}
              </div>
            )}
          </div>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            {t("cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={!label.trim() || !prompt.trim() || busy !== null}>
            {existing ? t("save") : t("we.newStep.create")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
