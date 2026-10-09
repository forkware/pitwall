// Building in the recipe: "+" between steps, "Add a step" at the end, a step's own actions in its card, and the
// branch a step's answers or results lead into.
import { ArrowDown, ArrowUp, Copy, GitFork, Plus, Trash2, Undo2 } from "lucide-react";
import {
  Button,
  cx,
  getState,
  known,
  stepText,
  t,
  toast,
  useUi,
  type NodeSpec,
  type StepInfo,
  type ProcessSpec,
} from "#sdk/ui";
import type { RecipeRow } from "./model.ts";
import { dropBranch, duplicateNode, freeName, insertBefore, makeBranch, moveNode, removeNode } from "./build.ts";
import { openStepPicker, type Picked } from "./StepPicker.tsx";
import { nodeName, valueWords } from "./text.ts";
import { Select } from "./EditCard.tsx";
import type { DraftState } from "./useDraft.ts";

const compact = (node: NodeSpec): string | NodeSpec => (Object.keys(node).length === 1 && node.step ? node.step : node);

/**
 * A new step's node, with its parameters' defaults in the user's language when its plugin gives them
 * (`tdefault:<step>:<param>`): "Is it done?" becomes "Готово?" in the recipe and on the task.
 */
function localized(node: NodeSpec): NodeSpec {
  const step = node.step ? getState().data?.processes.steps.find((s) => s.id === node.step) : undefined;
  if (!step) return node;
  const params: Record<string, unknown> = { ...node.params };
  for (const key of Object.keys(step.params)) {
    const words = `tdefault:${step.id}:${key}`;
    if (params[key] === undefined && known(words)) params[key] = t(words);
  }
  return Object.keys(params).length ? { ...node, params } : node;
}

/** Adds what was picked before `before`: the step that makes what it needs first, then it. Returns its node. */
export function addPicked(draft: DraftState, before: string, picked: Picked): string {
  let name = "";
  draft.change((spec) => {
    let next = spec;
    if (picked.before) next = insertBefore(next, before, freeName(next, picked.before.from), compact(localized(picked.before.node)));
    name = freeName(next, picked.from);
    return insertBefore(next, before, name, compact(localized(picked.node)));
  });
  return name;
}

export function pickAndAdd(draft: DraftState, self: string, before: string, where: string, select: (node: string) => void): void {
  openStepPicker({ spec: draft.spec, self, where, onPick: (picked) => select(addPicked(draft, before, picked)) });
}

/** The "+" between two steps: shown on hover and on focus, and Insert on the step above. */
export function Between({ next, where, onAdd }: { next: string; where: string; onAdd: () => void }) {
  return (
    <div className="group/plus relative z-10 -my-1 flex h-2 items-center justify-center" data-before={next}>
      <button
        aria-label={where}
        title={where}
        onClick={onAdd}
        className="grid size-5 place-items-center rounded-full border border-line bg-panel text-faint opacity-0 transition-opacity hover:border-accent hover:text-accent focus-visible:opacity-100 focus-visible:outline-none group-hover/plus:opacity-100"
      >
        <Plus size={12} />
      </button>
    </div>
  );
}

/** At the end of the recipe; in an empty process, the first steps people add. */
export function AddAtEnd({ draft, self, rows, select }: { draft: DraftState; self: string; rows: RecipeRow[]; select: (node: string) => void }) {
  const steps = useUi((s) => s.data?.processes.steps ?? []);
  const starters = ["basic-steps.describe", "basic-steps.agent-task", "basic-steps.ask"]
    .map((id) => steps.find((s) => s.id === id))
    .filter((s): s is StepInfo => !!s);
  const add = (s: StepInfo) => select(addPicked(draft, "end", { node: { step: s.id }, from: s.id }));
  if (!rows.length) {
    return (
      <div className="mt-2 max-w-3xl rounded-lg border border-dashed border-line p-4 text-center">
        <p className="font-medium">{t("we.build.emptyTitle")}</p>
        <p className="mt-1 text-muted">{t("we.build.emptyBody")}</p>
        <div className="mt-3 flex flex-wrap justify-center gap-2">
          {starters.map((s) => (
            <Button key={s.id} size="sm" onClick={() => add(s)}>
              {stepText(s)}
            </Button>
          ))}
          <Button size="sm" variant="ghost" icon={Plus} onClick={() => pickAndAdd(draft, self, "end", t("we.pick.atEnd"), select)}>
            {t("we.build.other")}
          </Button>
        </div>
      </div>
    );
  }
  return (
    <button
      className="ml-3 mt-2 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted hover:bg-hover hover:text-text"
      onClick={() => pickAndAdd(draft, self, "end", t("we.pick.atEnd"), select)}
    >
      <Plus size={13} /> {t("we.build.add")}
    </button>
  );
}

/** Removes a step, with "Undo" in a toast. */
export function removeWithUndo(draft: DraftState, row: RecipeRow, close: () => void): void {
  draft.change((spec) => removeNode(spec, row.node));
  close();
  toast(t("we.build.removed", { name: nodeName(row) }), "info", { action: { label: t("we.undo"), run: draft.undo } });
}

export function CardActions({ row, rows, draft, close, select }: { row: RecipeRow; rows: RecipeRow[]; draft: DraftState; close: () => void; select: (node: string) => void }) {
  const i = rows.indexOf(row);
  return (
    <div className="flex flex-wrap gap-1.5 border-t border-line pt-3">
      <Button size="sm" variant="ghost" icon={ArrowUp} disabled={i === 0} onClick={() => draft.change((s) => moveNode(s, row.node, -1))} title="Alt+↑">
        {t("we.build.up")}
      </Button>
      <Button size="sm" variant="ghost" icon={ArrowDown} disabled={i === rows.length - 1} onClick={() => draft.change((s) => moveNode(s, row.node, 1))} title="Alt+↓">
        {t("we.build.down")}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        icon={Copy}
        onClick={() => {
          let name = "";
          draft.change((s) => {
            const result = duplicateNode(s, row.node);
            name = result.name;
            return result.spec;
          });
          select(name);
        }}
      >
        {t("we.build.duplicate")}
      </Button>
      <Button size="sm" variant="ghost" icon={Trash2} className="text-[var(--danger)]" onClick={() => removeWithUndo(draft, row, close)} title="Del">
        {t("we.build.remove")}
      </Button>
    </div>
  );
}

/**
 * Where a step's answers or results lead: a branch on one of the keys it writes, offered with their values when the
 * step names them (its answers, its outcomes).
 */
export function BranchControls({ row, spec, change }: { row: RecipeRow; spec: ProcessSpec; change: (next: (spec: ProcessSpec) => ProcessSpec) => void }) {
  const branching = spec.edges.some(([f, to]) => f === row.node && typeof to === "object" && "on" in to);
  const keys = Object.entries({ ...(row.step?.outcomes ?? {}), ...row.info.outcomes }).filter(([, values]) => Object.keys(values).length > 0);
  if (branching) {
    return (
      <button className="mt-1.5 inline-flex items-center gap-1 text-xs text-muted hover:text-text" onClick={() => change((s) => dropBranch(s, row.node))}>
        <Undo2 size={12} /> {t("we.build.dropBranch")}
      </button>
    );
  }
  if (!keys.length) return null;
  return (
    <div className={cx("mt-1.5 flex items-center gap-2")}>
      <GitFork size={12} className="shrink-0 text-muted" />
      <Select
        label={t("we.build.branch")}
        value=""
        className="h-7 text-xs"
        onChange={(key) => key && change((s) => makeBranch(s, row.node, key, Object.keys(Object.fromEntries(keys)[key] ?? {})))}
        options={[
          { value: "", label: t("we.build.branch") },
          ...keys.map(([key, values]) => ({
            value: key,
            label: t("we.build.branchOn", { values: Object.keys(values).map((v) => valueWords(row.step, key, v, row.info)).join(" / ") }),
          })),
        ]}
      />
    </div>
  );
}
