// The recipe: a process's steps top to bottom, grouped by the task's status, with who does each and where it goes.
import { Bot, CircleAlert, CornerDownLeft, Flag, UserRound } from "lucide-react";
import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  cx,
  selectTask,
  statusColor,
  StatusDot,
  t,
  useUi,
  ProcessIcon,
  type StatusColor,
  type ProcessInfo,
  type ProcessRun,
} from "#sdk/ui";
import type { NextPart, RecipeRow } from "./model.ts";
import { fieldLabel, nodeName, questionTitle, statusName, valueWords } from "./text.ts";
import { InnerSteps, mappingText, UnfoldButton } from "./Nested.tsx";

export function RoleIcon({ row, size = 14 }: { row: Pick<RecipeRow, "info" | "step">; size?: number }) {
  const role = row.info.role;
  const label = t(`we.who.${role}`);
  if (role === "you") return <UserRound size={size} className="shrink-0 text-accent" aria-label={label} />;
  if (role === "agent") return <Bot size={size} className="shrink-0 text-[var(--s-violet)]" aria-label={label} />;
  return (
    <span aria-label={label} className="inline-flex shrink-0 text-muted">
      <ProcessIcon name={row.info.icon ?? row.step?.icon ?? "cog"} size={size} />
    </span>
  );
}

/** "passed → 7 · failed ↩ 4". */
export function NextLine({ parts, row }: { parts: NextPart[]; row: RecipeRow }) {
  if (!parts.length) return null;
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-0.5">
      {parts.map((p, i) => (
        <span key={i} className={cx("inline-flex items-center gap-1", p.back && "text-[var(--s-amber)]")}>
          {p.otherwise ? t("we.otherwise") : p.label !== undefined ? labelOf(row, p) : null}
          {(p.label !== undefined || p.otherwise) && " "}
          {p.end ? (
            <span className="inline-flex items-center gap-1">
              → <Flag size={11} /> {t("we.toEnd")}
            </span>
          ) : p.back ? (
            <span className="inline-flex items-center gap-0.5">
              <CornerDownLeft size={11} /> {p.n}
            </span>
          ) : (
            <span>→ {p.n}</span>
          )}
        </span>
      ))}
    </span>
  );
}

/** The values that lead somewhere, in the user's language. */
function labelOf(row: RecipeRow, part: NextPart): string {
  if (part.key && part.values) return part.values.map((v) => valueWords(row.step, part.key!, v, row.info)).join(", ");
  return part.label ?? "";
}

/** What makes a step clear at a glance: its form's fields, its question, its command. */
function detailOf(row: RecipeRow): string {
  const q = row.info.questions.find((x) => !x.when) ?? undefined;
  if (row.info.role === "you" && q) {
    if (q.kind === "form" && q.fields?.length) return t("we.form", { fields: q.fields.map((f) => fieldLabel(row.step, f).toLowerCase()).join(", ") });
    return questionTitle(row.step, q);
  }
  const command = row.spec.params?.command;
  if (typeof command === "string" && command) return command;
  return "";
}

export function Recipe({
  process,
  rows,
  selected,
  onSelect,
  runs,
  highlight,
  trailing,
  doneStatus,
  marks,
  picked,
  onPickMore,
}: {
  process: ProcessInfo;
  rows: RecipeRow[];
  selected?: string;
  onSelect: (node: string) => void;
  runs: ProcessRun[];
  /** A task to point at: "the task is here". */
  highlight?: string;
  /** Put after each row: the "+" of the edit mode. */
  trailing?: (row: RecipeRow, index: number) => ReactNode;
  doneStatus: string;
  /** Steps a draft added or changed. */
  marks?: Record<string, "+" | "~">;
  /** Steps picked with Shift+click in the edit mode, to take out into a process of their own. */
  picked?: string[];
  onPickMore?: (node: string) => void;
}) {
  const tasks = useUi((s) => s.data?.tasks ?? []);
  const statuses = useUi((s) => s.data?.statuses ?? []);
  const steps = useUi((s) => s.data?.processes.steps ?? []);
  const [unfolded, setUnfolded] = useState<Record<string, boolean>>({});
  const issues = process.issues;
  const list = useRef<HTMLOListElement>(null);
  const colorOf = (id?: string): StatusColor => statuses.find((s) => s.id === id)?.color ?? "gray";

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const buttons = [...(list.current?.querySelectorAll<HTMLButtonElement>("[data-row]") ?? [])];
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = buttons[e.key === "ArrowDown" ? Math.min(buttons.length - 1, i + 1) : Math.max(0, i - 1)];
    if (next) {
      e.preventDefault();
      next.focus();
    }
  };

  return (
    <ol ref={list} className="relative" onKeyDown={onKeyDown} aria-label={t("we.recipe")}>
      {rows.map((row, i) => {
        const here = runs.filter((r) => r.path[0] === row.node);
        const shown = here.slice(0, 3);
        const rowIssues = issues.filter((x) => x.node === row.node);
        const color = colorOf(row.status);
        const detail = detailOf(row);
        return (
          <li key={row.node} className="relative">
            {row.groupStart && (
              <div className="flex items-center gap-2 pb-1 pl-1 pt-3 text-[11px] font-semibold uppercase tracking-[0.06em] text-faint first:pt-0">
                <StatusDot color={color} />
                {statusName(row.status)}
              </div>
            )}
            <div className="relative pl-3">
              <span className="absolute bottom-0 left-[3px] top-0 w-[2px] rounded-full" style={{ background: statusColor[color] }} />
              <button
                data-row
                onClick={(e) => (e.shiftKey && onPickMore ? onPickMore(row.node) : onSelect(row.node))}
                aria-current={selected === row.node ? "true" : undefined}
                aria-pressed={picked?.includes(row.node) || undefined}
                aria-label={`${row.n}. ${nodeName(row)}. ${t(`we.who.${row.info.role}`)}`}
                className={cx(
                  "group flex w-full items-start gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-accent",
                  selected === row.node ? "bg-hover" : "hover:bg-hover/60",
                  picked?.includes(row.node) && "outline outline-1 outline-accent",
                  row.info.role === "you" && "bg-[color-mix(in_srgb,var(--accent)_6%,transparent)]",
                  row.spec.skip && "opacity-50",
                )}
              >
                <span className="w-5 shrink-0 pt-px text-right text-xs tabular-nums text-faint">
                  {marks?.[row.node] && (
                    <span
                      className={cx("mr-0.5 font-mono", marks[row.node] === "+" ? "text-[var(--s-green)]" : "text-accent")}
                      aria-label={t(marks[row.node] === "+" ? "we.diff.markAdded" : "we.diff.markChanged")}
                    >
                      {marks[row.node]}
                    </span>
                  )}
                  {row.n}
                </span>
                <span className="pt-0.5">
                  <RoleIcon row={row} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-baseline gap-x-2">
                    <span className={cx("font-medium", row.spec.skip && "line-through")}>{nodeName(row)}</span>
                    {row.spec.skip && <span className="text-[11px] text-faint">{t("we.skipped")}</span>}
                    {row.spec.process && (
                      <UnfoldButton row={row} open={!!unfolded[row.node]} onToggle={() => setUnfolded({ ...unfolded, [row.node]: !unfolded[row.node] })} />
                    )}
                    {row.spec.pin && <span className="text-[11px] text-faint">{t("we.nested.copy")}</span>}
                    {detail && <span className="min-w-0 truncate text-xs text-muted">{detail}</span>}
                  </span>
                  {row.spec.process && mappingText(row, steps) && <span className="mt-0.5 block text-xs text-muted">{mappingText(row, steps)}</span>}
                  {row.next.length > 0 && (
                    <span className="mt-0.5 block text-xs text-muted">
                      <NextLine parts={row.next} row={row} />
                    </span>
                  )}
                  {row.deadEnd && <span className="mt-0.5 block text-xs text-[var(--danger)]">{t("we.deadEnd")}</span>}
                  {rowIssues.length > 0 && (
                    <span className="mt-0.5 flex items-center gap-1 text-xs text-[var(--danger)]">
                      <CircleAlert size={12} /> {rowIssues.length}
                    </span>
                  )}
                </span>
                {shown.length > 0 && (
                  <span className="flex shrink-0 flex-wrap justify-end gap-1">
                    {shown.map((r) => {
                      const task = tasks.find((x) => x.id === r.taskId);
                      return (
                        <span
                          key={r.taskId}
                          role="link"
                          tabIndex={0}
                          title={t("we.taskHere", { title: task?.title ?? "" })}
                          onClick={(e) => (e.stopPropagation(), selectTask(r.taskId))}
                          onKeyDown={(e) => e.key === "Enter" && (e.stopPropagation(), selectTask(r.taskId))}
                          className={cx(
                            "max-w-36 truncate rounded px-1.5 py-px text-[11px]",
                            r.taskId === highlight
                              ? "bg-accent text-accent-text"
                              : "bg-raised text-muted hover:text-text",
                          )}
                        >
                          {task?.title ?? ""}
                        </span>
                      );
                    })}
                    {here.length > 3 && <span className="text-[11px] text-faint">{t("we.moreTasks", { n: here.length - 3 })}</span>}
                  </span>
                )}
              </button>
            </div>
            {row.spec.process && unfolded[row.node] && <InnerSteps row={row} />}
            {trailing?.(row, i)}
          </li>
        );
      })}
      <li className="flex items-center gap-2 pl-1 pt-3 text-xs text-muted">
        <Flag size={12} className="text-faint" />
        {t("we.end", { status: statusName(doneStatus) })}
      </li>
    </ol>
  );
}
