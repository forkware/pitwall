// "You always answer “Merge”. Don't ask when…?": under a question the user answered the same way again and again.
// "Yes" opens "What to change?" with the request written; nothing changes until they take it.
import { Lightbulb } from "lucide-react";
import { useEffect, useState } from "react";
import { Button, rpc, t, useUi, type Task, type ProcessRun } from "#sdk/ui";
import { openProcess } from "./Catalog.tsx";
import { stepName } from "./text.ts";

export function HabitHint({ task, run }: { task: Task; run: ProcessRun }) {
  const def = useUi((s) => s.data?.processes.defs.find((w) => w.id === run.process));
  const steps = useUi((s) => s.data?.processes.steps ?? []);
  const question = run.request?.id ?? "main";
  const [habit, setHabit] = useState<{ answer: string; count: number } | null>(null);
  const [gone, setGone] = useState(false);
  useEffect(() => {
    if (run.request?.kind !== "choice" || question === "__step") return;
    let alive = true;
    void rpc<{ answer: string; count: number } | null>("process-editor", "habit", { process: run.process, node: run.node, question })
      .then((h) => alive && setHabit(h))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [run.process, run.node, question, run.updatedAt]);
  if (!habit || gone || run.request?.kind !== "choice" || !def?.editable) return null;
  const option = run.request.options.find((o) => o.id === habit.answer);
  if (!option) return null;
  const n = def.nodes.findIndex((x) => x.id === run.path[0]) + 1;
  const node = def.nodes.find((x) => x.id === run.path[0]);
  const step = stepName(steps.find((s) => s.id === node?.step), node?.label ?? "");
  const words = { answer: option.label, n, step, count: habit.count };
  return (
    <div className="mt-2.5 flex flex-wrap items-center gap-2 border-t border-line pt-2 text-xs text-muted">
      <Lightbulb size={13} className="shrink-0 text-[var(--s-amber)]" />
      <span className="min-w-0 flex-1">{t("we.habit.text", words)}</span>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => openProcess(run.process, { node: run.path[0], change: Date.now(), folderId: task.folderId, request: t("we.habit.request", words) })}
      >
        {t("we.habit.yes")}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          setGone(true);
          void rpc("process-editor", "habitNever", { process: run.process, node: run.node, question });
        }}
      >
        {t("we.habit.no")}
      </Button>
    </div>
  );
}
