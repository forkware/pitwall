// A process run as one step: its own steps unfold in place, and its card says what it gets, what it gives back,
// and whether it follows the process as it changes or keeps its own copy.
import { ChevronRight, ExternalLink } from "lucide-react";
import { useMemo, useState } from "react";
import { cx, keyText, t, useUi, ProcessIcon, processText, type ProcessInfo, type ProcessSpec } from "#sdk/ui";
import { recipe, type RecipeRow } from "./model.ts";
import { Field } from "./StepCard.tsx";
import { Select } from "./EditCard.tsx";
import { RoleIcon, NextLine } from "./Recipe.tsx";
import { setNode } from "./specs.ts";
import { nodeName } from "./text.ts";
import { openProcess } from "./Catalog.tsx";
import { asNode } from "./specs.ts";

/** The process a node runs: its pinned copy, or the installed one. */
export function useInner(row: Pick<RecipeRow, "spec">): { def?: ProcessInfo; spec?: ProcessSpec } {
  const def = useUi((s) => s.data?.processes.defs.find((w) => w.id === row.spec.process));
  return { def, spec: row.spec.pin ?? def?.spec };
}

/** The steps of a process run as one step, unfolded under it: numbered "2.1", read only. */
export function InnerSteps({ row }: { row: RecipeRow }) {
  const { def, spec } = useInner(row);
  const steps = useUi((s) => s.data?.processes.steps ?? []);
  const rows = useMemo(() => (def && spec ? recipe(def, spec, steps) : []), [def, spec, steps]);
  if (!rows.length) return null;
  return (
    <ol className="ml-10 mt-1 border-l border-dashed border-line pl-3" aria-label={def ? processText(def) : undefined}>
      {rows.map((r) => (
        <li key={r.node} className="flex items-start gap-2 py-0.5 text-xs text-muted">
          <span className="w-7 shrink-0 text-right tabular-nums text-faint">
            {row.n}.{r.n}
          </span>
          <RoleIcon row={r} size={12} />
          <span className="min-w-0">
            {nodeName(r)}
            {r.next.length > 0 && (
              <span className="ml-2 text-faint">
                <NextLine parts={r.next} row={r} />
              </span>
            )}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** "9 steps ▸": unfolds a process run as one step. */
export function UnfoldButton({ row, open, onToggle }: { row: RecipeRow; open: boolean; onToggle: () => void }) {
  const { def, spec } = useInner(row);
  const count = Object.keys(spec?.nodes ?? {}).length;
  if (!def) return null;
  return (
    <span
      role="button"
      tabIndex={0}
      aria-expanded={open}
      onClick={(e) => (e.stopPropagation(), onToggle())}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), e.stopPropagation(), onToggle())}
      className="inline-flex items-center gap-0.5 rounded px-1 text-[11px] text-faint hover:bg-hover hover:text-text"
    >
      {t("we.nested.steps", { n: count })}
      <ChevronRight size={11} className={cx("transition-transform", open && "rotate-90")} />
    </span>
  );
}

/** What the outer process gives the inner one, when it is not the same key: "description = the answer of step 1". */
export function mappingText(row: RecipeRow, steps: Parameters<typeof keyText>[1]): string {
  const pairs = Object.entries(row.spec.in ?? {}).filter(([inner, outer]) => inner !== outer);
  return pairs.map(([inner, outer]) => `${keyText(inner, steps)} = ${keyText(outer, steps)}`).join(", ");
}

/** The card of a process run as one step. */
export function NestedSection({
  row,
  spec,
  editing,
  change,
}: {
  row: RecipeRow;
  spec: ProcessSpec;
  editing: boolean;
  change: (next: (spec: ProcessSpec) => ProcessSpec) => void;
}) {
  const { def } = useInner(row);
  const steps = useUi((s) => s.data?.processes.steps ?? []);
  const defs = useUi((s) => s.data?.processes.defs ?? []);
  const [, force] = useState(0);
  if (!def) return <p className="text-[var(--danger)]">{t("we.nested.missing", { id: row.spec.process ?? "" })}</p>;
  // The keys this process makes before the inner one: what it can give.
  const outer = new Set<string>(Array.isArray(spec.inputs) ? spec.inputs : Object.keys(spec.inputs ?? {}));
  for (const n of Object.values(spec.nodes)) {
    const node = asNode(n);
    if (node.step) for (const k of steps.find((s) => s.id === node.step)?.writes ?? []) outer.add(k);
    if (node.process) for (const k of defs.find((d) => d.id === node.process)?.spec.outputs ?? []) outer.add(node.out?.[k] ?? k);
  }
  const options = [...outer].map((k) => ({ value: k, label: keyText(k, steps) }));
  const pinned = !!row.spec.pin;
  return (
    <>
      <button className="inline-flex items-center gap-1.5 text-left hover:underline" onClick={() => openProcess(def.id)}>
        <ProcessIcon name={def.icon} size={14} className="text-muted" />
        {processText(def)}
        <ExternalLink size={12} className="text-faint" />
      </button>
      {def.description && <p className="text-muted">{processText(def, "description")}</p>}
      {def.inputs.length > 0 && (
        <Field label={t("we.nested.gives", { name: processText(def) })}>
          <ul className="space-y-1.5">
            {def.inputs.map((input) => {
              const from = row.spec.in?.[input.key] ?? input.key;
              return (
                <li key={input.key}>
                  <div className="text-xs text-muted">{input.label === input.key ? keyText(input.key, steps) : input.label}</div>
                  {editing ? (
                    <Select
                      label={input.label}
                      value={from}
                      onChange={(v) =>
                        change((s) => {
                          const map = { ...(row.spec.in ?? {}) };
                          if (v === input.key) delete map[input.key];
                          else map[input.key] = v;
                          return setNode(s, row.node, { in: Object.keys(map).length ? map : null });
                        })
                      }
                      options={[...(outer.has(input.key) ? [] : [{ value: input.key, label: t("we.nested.nothing") }]), ...options]}
                    />
                  ) : (
                    <span>{outer.has(from) ? keyText(from, steps) : t("we.nested.nothing")}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </Field>
      )}
      {(def.spec.outputs ?? []).length > 0 && (
        <Field label={t("we.nested.back")}>{(def.spec.outputs ?? []).map((k) => keyText(row.spec.out?.[k] ?? k, steps)).join(", ")}</Field>
      )}
      <Field label={t("we.nested.follows")}>
        {editing ? (
          <div className="space-y-1">
            {[false, true].map((pin) => (
              <label key={String(pin)} className="flex items-start gap-2 text-[13px]">
                <input
                  type="radio"
                  className="mt-1 accent-[var(--accent)]"
                  checked={pinned === pin}
                  onChange={() => {
                    change((s) => setNode(s, row.node, { pin: pin ? def.spec : null }));
                    force((n) => n + 1);
                  }}
                />
                <span>
                  {t(pin ? "we.nested.pinned" : "we.nested.live")}
                  <span className="block text-xs text-muted">{t(pin ? "we.nested.pinnedHint" : "we.nested.liveHint")}</span>
                </span>
              </label>
            ))}
          </div>
        ) : (
          <span>{t(pinned ? "we.nested.pinned" : "we.nested.live")}</span>
        )}
      </Field>
    </>
  );
}
