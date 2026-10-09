// What the editor adds to the Process tab of a task's details: its recipe, and changing the task's step in words or
// in its card.
import { ListOrdered, Pencil, Sparkles } from "lucide-react";
import { Button, t, type Task, type ProcessRun } from "#sdk/ui";
import { openProcess } from "./Catalog.tsx";

export function ProcessLinks({ task, run }: { task: Task; run: ProcessRun }) {
  const node = run.state === "done" ? undefined : run.path[0];
  return (
    <>
      <Button size="sm" variant="ghost" icon={ListOrdered} onClick={() => openProcess(run.process, { taskId: task.id, node })}>
        {t("we.openRecipe")}
      </Button>
      {node && (
        <>
          <Button
            size="sm"
            variant="ghost"
            icon={Sparkles}
            onClick={() => openProcess(run.process, { node, change: Date.now(), folderId: task.folderId, taskId: task.id })}
          >
            {t("we.changeThisStep")}
          </Button>
          <Button size="sm" variant="ghost" icon={Pencil} onClick={() => openProcess(run.process, { node, edit: true, taskId: task.id })}>
            {t("we.tuneThisStep")}
          </Button>
        </>
      )}
    </>
  );
}
