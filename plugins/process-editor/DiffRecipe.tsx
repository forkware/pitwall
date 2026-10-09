// Two versions of a process as one recipe: what was added in green with "+", what changed with "~", what went
// struck through. Used to compare with the original, with an older version, and for an agent's proposal.
import { useMemo, type ReactNode } from "react";
import { Button, cx, Dialog, showCustomDialog, t, useUi, type ProcessInfo, type ProcessSpec } from "#sdk/ui";
import { recipe, type RecipeRow } from "./model.ts";
import { NextLine, RoleIcon } from "./Recipe.tsx";
import { diffSpecs } from "./specs.ts";
import { nodeName, statusName } from "./text.ts";

export function DiffRecipe({ before, after, info }: { before: ProcessSpec; after: ProcessSpec; info: ProcessInfo }) {
  const steps = useUi((s) => s.data?.processes.steps ?? []);
  const diff = useMemo(() => diffSpecs(before, after), [before, after]);
  const rowsAfter = useMemo(() => recipe(info, after, steps), [info, after, steps]);
  const rowsBefore = useMemo(() => recipe(info, before, steps), [info, before, steps]);
  // Removed steps go where they were: after the step that came before them.
  const merged: { row: RecipeRow; mark: "+" | "~" | "-" | "" }[] = [];
  for (const row of rowsAfter) {
    merged.push({ row, mark: diff.added.includes(row.node) ? "+" : diff.changed.includes(row.node) ? "~" : "" });
  }
  for (const gone of rowsBefore.filter((r) => diff.removed.includes(r.node))) {
    const prevIndex = rowsBefore.indexOf(gone) - 1;
    const anchor = prevIndex >= 0 ? merged.findIndex((m) => m.row.node === rowsBefore[prevIndex].node) : -1;
    merged.splice(anchor + 1, 0, { row: gone, mark: "-" });
  }
  if (diff.count === 0) return <p className="text-muted">{t("we.diff.same")}</p>;
  return (
    <ol className="space-y-0.5">
      {diff.about && (
        <li className="rounded-md px-2 py-1 text-xs text-accent">
          ~ {t("we.diff.about", { before: before.label, after: after.label })}
          {before.doneStatus !== after.doneStatus && ` · ${t("we.end", { status: statusName(after.doneStatus ?? "done") })}`}
        </li>
      )}
      {merged.map(({ row, mark }) => (
        <li
          key={`${mark}${row.node}`}
          className={cx(
            "flex items-start gap-2 rounded-md px-2 py-1",
            mark === "+" && "bg-[color-mix(in_srgb,var(--s-green)_10%,transparent)]",
            mark === "~" && "bg-[color-mix(in_srgb,var(--accent)_8%,transparent)]",
            mark === "-" && "opacity-60",
          )}
        >
          <span
            className={cx(
              "w-3 shrink-0 text-center font-mono text-xs",
              mark === "+" && "text-[var(--s-green)]",
              mark === "~" && "text-accent",
              mark === "-" && "text-[var(--danger)]",
            )}
            aria-label={mark ? t(`we.diff.mark${mark === "+" ? "Added" : mark === "~" ? "Changed" : "Removed"}`) : undefined}
          >
            {mark === "-" ? "−" : mark}
          </span>
          <span className="w-5 shrink-0 text-right text-xs tabular-nums text-faint">{mark === "-" ? "" : row.n}</span>
          <span className="pt-0.5">
            <RoleIcon row={row} size={13} />
          </span>
          <span className="min-w-0 flex-1">
            <span className={cx("font-medium", mark === "-" && "line-through")}>{nodeName(row)}</span>
            {row.spec.skip && <span className="ml-2 text-[11px] text-faint">{t("we.skipped")}</span>}
            {row.next.length > 0 && mark !== "-" && (
              <span className="block text-xs text-muted">
                <NextLine parts={row.next} row={row} />
              </span>
            )}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** A dialog with two versions side by side as one recipe, and the actions that go with them. */
export function openDiff(options: {
  title: string;
  description?: string;
  before: ProcessSpec;
  after: ProcessSpec;
  info: ProcessInfo;
  actions?: (close: () => void) => ReactNode;
}): void {
  showCustomDialog(({ open, onOpenChange }) => (
    <Dialog open={open} onOpenChange={onOpenChange} wide title={options.title} description={options.description}>
      <div className="max-h-[55vh] overflow-y-auto">
        <DiffRecipe before={options.before} after={options.after} info={options.info} />
      </div>
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        {options.actions?.(() => onOpenChange(false))}
        <Button variant="primary" onClick={() => onOpenChange(false)}>
          {t("close")}
        </Button>
      </div>
    </Dialog>
  ));
}
