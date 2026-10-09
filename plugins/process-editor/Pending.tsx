// The stand-in for a step an agent is making in code: which task makes it, and the way to put the step in its place
// once the app restarted with it.
import { Hammer } from "lucide-react";
import { Button, openTask, t, useUi, type ProcessSpec } from "#sdk/ui";
import type { RecipeRow } from "./model.ts";
import { openStepPicker } from "./StepPicker.tsx";
import { setNode } from "./specs.ts";

export const PENDING = "prompt-steps.pending";

export function PendingSection({
  row,
  spec,
  change,
}: {
  row: RecipeRow;
  spec: ProcessSpec;
  change?: (next: (spec: ProcessSpec) => ProcessSpec) => void;
}) {
  const taskId = row.spec.params?.task as string | undefined;
  const task = useUi((s) => s.data?.tasks.find((x) => x.id === taskId));
  const done = useUi((s) => s.data?.statuses.find((x) => x.id === task?.status)?.category === "done");
  return (
    <div className="space-y-2 rounded-md border border-dashed border-line p-2.5">
      <div className="flex items-start gap-2">
        <Hammer size={14} className="mt-0.5 shrink-0 text-muted" />
        <span>
          {task ? t(done ? "we.pending.ready" : "we.pending.making", { task: task.title }) : t("we.pending.gone")}
          {typeof row.spec.params?.description === "string" && <span className="block text-xs text-muted">{row.spec.params.description}</span>}
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        {task && (
          <Button size="sm" variant="ghost" onClick={() => void openTask(task.id)}>
            {t("we.pending.open")}
          </Button>
        )}
        {change && (
          <Button
            size="sm"
            onClick={() =>
              openStepPicker({
                spec,
                self: "",
                where: t("we.pending.replace"),
                onPick: (picked) => change((s) => setNode(s, row.node, { step: picked.node.step ?? null, process: picked.node.process ?? null, params: null })),
              })
            }
          >
            {t("we.pending.replace")}
          </Button>
        )}
      </div>
    </div>
  );
}
