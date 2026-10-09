// The editor's interface: the catalog of processes, a process's page with its recipe, and in a task's details
// (the Process tab) the way to the recipe and to changing the task's step.
import "./strings.ts";
import { GitCompareArrows, HelpCircle, ListOrdered, Workflow } from "lucide-react";
import { useEffect } from "react";
import {
  Button,
  cx,
  onEvent,
  rpc,
  toast,
  type ProcessVersion,
  defineUiPlugin,
  getState,
  openDetails,
  t,
  useUi,
  type Task,
  type ProcessRun,
} from "#sdk/ui";
import { CatalogPage, openCatalog, openProcess } from "./Catalog.tsx";
import { ProcessPage } from "./ProcessPage.tsx";
import { ProcessLinks } from "./barExtras.tsx";
import { openDiff } from "./DiffRecipe.tsx";
import { HabitHint } from "./Habit.tsx";

/** A step an agent was making for a stand-in is done: the user restarts the app and puts it in place. */
function usePendingDone(): void {
  useEffect(
    () =>
      onEvent((name, payload: { task?: Task; to?: string }) => {
        if (name !== "task.status.changed" || !payload?.task) return;
        const data = getState().data;
        if (data?.statuses.find((s) => s.id === payload.to)?.category !== "done") return;
        const waiting = data?.processes.defs.find((w) =>
          Object.values(w.spec.nodes).some((n) => typeof n === "object" && n.step === "prompt-steps.pending" && n.params?.task === payload.task!.id),
        );
        if (waiting) toast(t("we.pending.toast", { task: payload.task.title }), "info", { action: { label: t("we.open"), run: () => openProcess(waiting.id, { edit: true }) }, duration: 15000 });
      }),
    [],
  );
}

/** "Processes" under the tree, with Automations and the Archive. */
function SidebarItem() {
  usePendingDone();
  const active = useUi((s) => s.selection?.kind === "page" && s.selection.plugin === "process-editor");
  const broken = useUi((s) => s.data?.processes.defs.some((w) => !w.template && w.problems.length > 0) ?? false);
  return (
    <button
      className={cx(
        "flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-[13px] transition-colors",
        active ? "bg-hover text-text" : "text-muted hover:bg-hover/60 hover:text-text",
      )}
      onClick={() => openCatalog()}
    >
      <Workflow size={14} strokeWidth={1.75} />
      {t("we.processes")}
      {broken && <span className="ml-auto size-1.5 rounded-full bg-danger" title={t("we.withProblems")} />}
    </button>
  );
}

/** In the task's header: the process changed since the task started, and the way to see how. */
function ChangedNotice({ task, run }: { task: Task; run: ProcessRun }) {
  const def = useUi((s) => s.data?.processes.defs.find((w) => w.id === run.process));
  const changed = !!def?.version && !!run.version && def.version !== run.version;
  if (!changed) return null;
  return (
    <button
      className="inline-flex items-center gap-1 rounded px-1.5 py-px text-[11px] text-[var(--s-amber)] hover:bg-hover"
      onClick={() => void showChanges(task, run)}
    >
      <GitCompareArrows size={12} />
      {t("we.changedAfterStart")}
    </button>
  );
}

/** What changed in the process since the task started, with the way to move the task to the new version. */
async function showChanges(task: Task, run: ProcessRun): Promise<void> {
  const def = getState().data?.processes.defs.find((w) => w.id === run.process);
  if (!def) return;
  const versions = await rpc<ProcessVersion[]>("process-editor", "versions", { id: def.id }).catch(() => []);
  const started = versions.find((v) => v.version === run.version);
  if (!started) return;
  openDiff({
    title: t("we.changedTitle"),
    description: t("we.changedBody"),
    before: started.spec,
    after: def.spec,
    info: def,
    actions: (close) => (
      <Button
        variant="ghost"
        onClick={() =>
          void rpc("process-editor", "upgrade", { taskId: task.id })
            .then(() => {
              close();
              toast(t("we.upgraded"));
            })
            .catch((error) => toast((error as Error).message, "error"))
        }
      >
        {t("we.upgrade")}
      </Button>
    ),
  });
}

const runOf = (task: Task) => getState().data?.processes.runs.find((r) => r.taskId === task.id);

export default defineUiPlugin({
  pages: { catalog: CatalogPage, process: ProcessPage },
  slots: {
    "sidebar.nav": SidebarItem,
    "process.bar": ChangedNotice,
    "process.question": HabitHint,
    "task.details.process": ProcessLinks,
  },
  commands: [
    { id: "process-editor.catalog", label: t("we.processes"), keywords: ["process", "процесс"], icon: Workflow, run: () => openCatalog() },
    {
      id: "process-editor.taskProcess",
      label: t("we.taskProcess"),
      scope: "task",
      icon: ListOrdered,
      run: (task) => {
        const run = runOf(task);
        if (run) openProcess(run.process, { taskId: task.id, node: run.path[0] });
      },
    },
    {
      id: "process-editor.whyHere",
      label: t("we.whyHere"),
      scope: "task",
      icon: HelpCircle,
      // The Process tab of the task's details tells it now: the steps it ran, what each ended with.
      run: () => openDetails("process"),
    },
  ],
});
