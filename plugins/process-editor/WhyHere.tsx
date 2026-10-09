// "Why is the task here?": the steps its process ran, with what each ended with, oldest first.
import { CircleAlert, CircleCheck, CornerDownLeft, LoaderCircle, MessageCircleQuestion, SkipForward } from "lucide-react";
import { useEffect, useState } from "react";
import {
  Button,
  cx,
  Dialog,
  getState,
  onEvent,
  rpc,
  showCustomDialog,
  t,
  type StepInfo,
  type Task,
  type ProcessInfo,
  type ProcessTraceEntry,
} from "#sdk/ui";
import { stepName, valueWords } from "./text.ts";
import { openProcess } from "./Catalog.tsx";

export function useTrace(taskId: string | undefined): ProcessTraceEntry[] {
  const [trace, setTrace] = useState<ProcessTraceEntry[]>([]);
  useEffect(() => {
    if (!taskId) return;
    let alive = true;
    const load = () => void rpc<ProcessTraceEntry[]>("process-editor", "trace", { taskId }).then((x) => alive && setTrace(x)).catch(() => {});
    load();
    const off = onEvent((name, payload) => name === "process.updated" && payload?.taskId === taskId && load());
    return () => {
      alive = false;
      off();
    };
  }, [taskId]);
  return trace;
}

/** A trace entry in words: the step's name, and what it ended with. */
export function entryWords(entry: ProcessTraceEntry, defs: ProcessInfo[], steps: StepInfo[], processId: string) {
  const step = steps.find((s) => s.id === entry.step);
  // The node's own name, through the processes it ran inside.
  let def = defs.find((d) => d.id === processId);
  let name = stepName(step, entry.node);
  for (const id of entry.node.split("/")) {
    const node = def?.nodes.find((n) => n.id === id);
    if (node && !node.process && node.label && node.label !== step?.label) name = node.label;
    if (node?.process) def = defs.find((d) => d.id === node.process);
  }
  const outcomes = Object.entries(entry.output ?? {})
    .filter(([key]) => step?.outcomes[key])
    .map(([key, value]) => valueWords(step, key, typeof value === "string" ? value : JSON.stringify(value)));
  let result: string;
  switch (entry.result) {
    case "done":
      result = outcomes.join(", ") || t("we.stepDone");
      break;
    case "asked":
      result = t("we.stepAsked");
      break;
    case "answered": {
      const answer = typeof entry.answer === "string" ? valueWords(step, "", entry.answer) : t("we.stepDone");
      result = t("we.stepAnswered", { answer });
      break;
    }
    case "failed":
      result = t("we.stepFailed", { error: entry.error ?? "" });
      break;
    case "skipped":
      result = t("we.stepSkipped");
      break;
    default:
      result = t("we.stepRunning");
  }
  return { name, result };
}

export function TracePath({ trace, process }: { trace: ProcessTraceEntry[]; process: string }) {
  const data = getState().data;
  const defs = data?.processes.defs ?? [];
  const steps = data?.processes.steps ?? [];
  const order = Object.keys(defs.find((d) => d.id === process)?.spec.nodes ?? {});
  if (!trace.length) return <p className="text-muted">{t("we.pathEmpty")}</p>;
  return (
    <ol className="space-y-0.5">
      {trace.map((entry, i) => {
        const { name, result } = entryWords(entry, defs, steps, process);
        const prev = trace[i - 1];
        const back = prev && order.indexOf(entry.node.split("/")[0]) <= order.indexOf(prev.node.split("/")[0]);
        const Icon =
          entry.result === "failed"
            ? CircleAlert
            : entry.result === "asked"
              ? MessageCircleQuestion
              : entry.result === "running"
                ? LoaderCircle
                : entry.result === "skipped"
                  ? SkipForward
                  : CircleCheck;
        return (
          <li key={entry.seq} className="flex items-start gap-2 rounded-md px-1 py-1">
            <span className="w-4 shrink-0 pt-0.5 text-faint">{back ? <CornerDownLeft size={13} className="text-[var(--s-amber)]" /> : null}</span>
            <Icon
              size={14}
              className={cx(
                "mt-0.5 shrink-0",
                entry.result === "failed" ? "text-[var(--danger)]" : entry.result === "asked" ? "text-accent" : "text-faint",
                entry.result === "running" && "animate-spin",
              )}
            />
            <span className="min-w-0 flex-1">
              <span className="font-medium">{name}</span>
              <span className="text-muted"> — {result}</span>
            </span>
            <span className="shrink-0 text-[11px] tabular-nums text-faint">{new Date(entry.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
          </li>
        );
      })}
    </ol>
  );
}

export function openWhyHere(task: Task, process: string): void {
  showCustomDialog(({ open, onOpenChange }) => <WhyHereDialog task={task} process={process} open={open} onOpenChange={onOpenChange} />);
}

function WhyHereDialog({ task, process, open, onOpenChange }: { task: Task; process: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const trace = useTrace(task.id);
  return (
    <Dialog open={open} onOpenChange={onOpenChange} wide title={t("we.whyHere")} description={task.title}>
      <div className="max-h-[55vh] overflow-y-auto">
        <TracePath trace={trace} process={process} />
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button
          variant="ghost"
          onClick={() => {
            onOpenChange(false);
            openProcess(process, { taskId: task.id });
          }}
        >
          {t("we.openRecipe")}
        </Button>
        <Button variant="primary" onClick={() => onOpenChange(false)}>
          {t("close")}
        </Button>
      </div>
    </Dialog>
  );
}
