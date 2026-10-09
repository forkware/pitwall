// The schema: the same process as a graph, for an overview. Steps are boxes with their status's color, the ones
// that wait for you outlined, ways are arrows with the answers that lead along them. A click opens the step's card.
import { useEffect, useMemo, useState } from "react";
import { statusColor, t, useUi, type StatusColor, type ProcessInfo, type ProcessSpec } from "#sdk/ui";
import { recipe, type NextPart, type RecipeRow } from "./model.ts";
import { BOX, layout } from "./schema.ts";
import { nodeName, statusName, valueWords } from "./text.ts";

/** Whether the window is wide enough for the schema: on a phone the recipe is the process. */
export function useWide(): boolean {
  const query = "(min-width: 768px)";
  const [wide, setWide] = useState(() => typeof matchMedia === "undefined" || matchMedia(query).matches);
  useEffect(() => {
    if (typeof matchMedia === "undefined") return;
    const m = matchMedia(query);
    const on = () => setWide(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return wide;
}

const words = (row: RecipeRow, part: NextPart): string | undefined => {
  if (part.otherwise) return t("we.otherwise");
  if (part.key && part.values) return part.values.map((v) => valueWords(row.step, part.key!, v, row.info)).join(", ");
  return part.label;
};

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export function SchemaView({ def, spec, onPick }: { def: ProcessInfo; spec: ProcessSpec; onPick: (node: string) => void }) {
  const steps = useUi((s) => s.data?.processes.steps ?? []);
  const statuses = useUi((s) => s.data?.statuses ?? []);
  const rows = useMemo(() => recipe(def, spec, steps), [def, spec, steps]);
  const schema = useMemo(() => layout(rows, words), [rows]);
  const colorOf = (id?: string): string => statusColor[(statuses.find((s) => s.id === id)?.color ?? "gray") as StatusColor];
  return (
    <div className="overflow-auto px-4 py-4 sm:px-6">
      <svg
        width={schema.width}
        height={schema.height}
        role="img"
        aria-label={t("we.schema")}
        className="text-[13px]"
        style={{ fontFamily: "inherit" }}
      >
        <defs>
          <marker id="we-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 8 4 L 0 8 z" fill="var(--faint)" />
          </marker>
          <marker id="we-arrow-back" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 8 4 L 0 8 z" fill="var(--s-amber)" />
          </marker>
        </defs>
        {schema.edges.map((e, i) => (
          <g key={i}>
            <path
              d={e.path}
              fill="none"
              stroke={e.kind === "back" ? "var(--s-amber)" : "var(--faint)"}
              strokeWidth={1.4}
              markerEnd={`url(#${e.kind === "back" ? "we-arrow-back" : "we-arrow"})`}
            />
            {e.label && (
              <text x={e.label.x} y={e.label.y} textAnchor={e.label.anchor} className="fill-[var(--muted)]" style={{ fontSize: 11 }}>
                {clip(e.label.text, 28)}
              </text>
            )}
          </g>
        ))}
        {schema.boxes.map((b) => {
          const you = b.row.info.role === "you";
          return (
            <g
              key={b.node}
              role="button"
              tabIndex={0}
              aria-label={`${b.row.n}. ${nodeName(b.row)}`}
              className="cursor-pointer outline-none [&:focus-visible>rect]:stroke-[var(--accent)]"
              onClick={() => onPick(b.node)}
              onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onPick(b.node))}
            >
              <rect
                x={b.x}
                y={b.y}
                width={BOX.w}
                height={BOX.h}
                rx={8}
                fill={you ? "color-mix(in srgb, var(--accent) 9%, var(--panel))" : "var(--panel)"}
                stroke={you ? "var(--accent)" : "var(--line)"}
                strokeWidth={you ? 1.4 : 1}
                opacity={b.row.spec.skip ? 0.5 : 1}
              />
              <rect x={b.x} y={b.y + 8} width={3} height={BOX.h - 16} rx={1.5} fill={colorOf(b.row.status)} />
              <text x={b.x + 14} y={b.y + 19} className="fill-[var(--faint)]" style={{ fontSize: 11 }}>
                {b.row.n} · {statusName(b.row.status)}
              </text>
              <text x={b.x + 14} y={b.y + 36} className="fill-[var(--text)]" style={{ fontWeight: 500 }}>
                {clip(nodeName(b.row), 30)}
              </text>
            </g>
          );
        })}
        <g>
          <circle cx={schema.end.x} cy={schema.end.y} r={7} fill="none" stroke="var(--faint)" strokeWidth={1.4} />
          <circle cx={schema.end.x} cy={schema.end.y} r={3} fill="var(--faint)" />
          <text x={schema.end.x + 14} y={schema.end.y + 4} className="fill-[var(--muted)]" style={{ fontSize: 11 }}>
            {t("we.end", { status: statusName(spec.doneStatus ?? "done") })}
          </text>
        </g>
      </svg>
    </div>
  );
}
