// "Add a step": find it by what it does, grouped by who does it. A step that needs something no step makes yet is
// greyed with why, and adding it adds the step that makes it too. A process can be a step too.
import { Search, Sparkles, Wrench } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import {
  Button,
  cx,
  Dialog,
  Input,
  keyText,
  showCustomDialog,
  stepText,
  t,
  useUi,
  ProcessIcon,
  processText,
  type NodeSpec,
  type StepInfo,
  type ProcessInfo,
  type ProcessSpec,
} from "#sdk/ui";
import { askForStep } from "./askForStep.tsx";
import { openNewStep } from "./newStep.tsx";
import { asNode } from "./specs.ts";

/** What the user picked: a step, or a process run as one step; and the step that makes what it needs, if any. */
export interface Picked {
  node: NodeSpec;
  from: string;
  before?: { node: NodeSpec; from: string };
}

const GROUPS = ["you", "agent", "tests", "git", "github"] as const;
const groupOf = (s: StepInfo) => (s.group && (GROUPS as readonly string[]).includes(s.group) ? s.group : s.role === "agent" ? "agent" : s.role === "you" ? "you" : "other");

/** Steps the user added most, remembered in this browser. */
function frequent(): string[] {
  try {
    const counts = JSON.parse(localStorage.getItem("we.frequent") ?? "{}") as Record<string, number>;
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([id]) => id);
  } catch {
    return [];
  }
}
function remember(id: string): void {
  try {
    const counts = JSON.parse(localStorage.getItem("we.frequent") ?? "{}") as Record<string, number>;
    counts[id] = (counts[id] ?? 0) + 1;
    localStorage.setItem("we.frequent", JSON.stringify(counts));
  } catch {}
}

/** The keys a process already makes: what it takes and what its steps write. */
function written(spec: ProcessSpec, steps: StepInfo[], defs: ProcessInfo[]): Set<string> {
  const keys = new Set(Array.isArray(spec.inputs) ? spec.inputs : Object.keys(spec.inputs ?? {}));
  for (const n of Object.values(spec.nodes)) {
    const node = asNode(n);
    if (node.step) for (const k of steps.find((s) => s.id === node.step)?.writes ?? []) keys.add(k);
    if (node.process) for (const k of defs.find((d) => d.id === node.process)?.spec.outputs ?? []) keys.add(node.out?.[k] ?? k);
  }
  return keys;
}

export function openStepPicker(options: { spec: ProcessSpec; self: string; where: string; onPick: (picked: Picked) => void }): void {
  showCustomDialog(({ open, onOpenChange }) => (
    <StepPicker
      {...options}
      open={open}
      onOpenChange={onOpenChange}
      onPick={(p) => {
        onOpenChange(false);
        options.onPick(p);
      }}
    />
  ));
}

function StepPicker({
  spec,
  self,
  where,
  onPick,
  open,
  onOpenChange,
}: {
  spec: ProcessSpec;
  self: string;
  where: string;
  onPick: (picked: Picked) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const steps = useUi((s) => s.data?.processes.steps ?? []);
  const defs = useUi((s) => s.data?.processes.defs ?? []);
  const [query, setQuery] = useState("");
  const made = useMemo(() => written(spec, steps, defs), [spec, steps, defs]);
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (text: string) => words.every((w) => text.toLowerCase().includes(w));

  /** What a step needs that nothing makes yet, and the steps that make it. */
  const missing = (s: StepInfo) => {
    const need = s.reads.filter((k) => !k.endsWith("?") && !made.has(k));
    const maker = need.length === 1 ? steps.find((x) => x.id !== s.id && x.writes.includes(need[0]) && x.reads.every((k) => k.endsWith("?") || made.has(k))) : undefined;
    return { need, maker };
  };
  const pickStep = (s: StepInfo) => {
    const { need, maker } = missing(s);
    if (need.length && !maker) return;
    remember(s.id);
    onPick({ node: { step: s.id }, from: s.id, ...(maker ? { before: { node: { step: maker.id }, from: maker.id } } : {}) });
  };

  const shownSteps = steps.filter((s) => matches(`${stepText(s)} ${stepText(s, "description")} ${s.label} ${s.description ?? ""}`));
  const processes = defs.filter((w) => w.id !== self && !w.template && matches(`${processText(w)} ${processText(w, "description")}`));
  const often = frequent()
    .map((id) => steps.find((s) => s.id === id))
    .filter((s): s is StepInfo => !!s);
  const starters = often.length ? often : ["basic-steps.ask", "basic-steps.agent-task", "basic-steps.command"].map((id) => steps.find((s) => s.id === id)).filter((s): s is StepInfo => !!s);

  const Row = ({ s }: { s: StepInfo }) => {
    const { need, maker } = missing(s);
    const blocked = need.length > 0 && !maker;
    return (
      <li>
        <button
          disabled={blocked}
          onClick={() => pickStep(s)}
          className="flex w-full items-start gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-hover focus-visible:bg-hover focus-visible:outline-none disabled:opacity-50"
        >
          <ProcessIcon name={s.icon ?? (s.role === "agent" ? "bot" : s.role === "you" ? "user-round" : "cog")} size={14} className="mt-0.5 shrink-0 text-muted" />
          <span className="min-w-0">
            <span className="block">{stepText(s)}</span>
            {stepText(s, "description") && <span className="block text-xs text-muted">{stepText(s, "description")}</span>}
            {need.length > 0 && (
              <span className={cx("block text-xs", blocked ? "text-faint" : "text-accent")}>
                {maker
                  ? t("we.pick.withMaker", { what: need.map((k) => keyText(k, steps)).join(", "), step: stepText(maker) })
                  : t("we.pick.needs", { what: need.map((k) => keyText(k, steps)).join(", ") })}
              </span>
            )}
          </span>
        </button>
      </li>
    );
  };

  const groups = [...GROUPS, "other"].map((g) => [g, shownSteps.filter((s) => groupOf(s) === g)] as const).filter(([, list]) => list.length);
  return (
    <Dialog open={open} onOpenChange={onOpenChange} wide title={t("we.pick.title")} description={where}>
      <div className="relative mb-3">
        <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
        <Input autoFocus className="h-8 pl-8" placeholder={t("we.pick.find")} value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <div className="-mx-1 max-h-[55vh] overflow-y-auto">
        {!words.length && starters.length > 0 && (
          <Group title={t("we.pick.often")}>
            {starters.map((s) => (
              <Row key={`often-${s.id}`} s={s} />
            ))}
          </Group>
        )}
        {groups.map(([g, list]) => (
          <Group key={g} title={t(`we.group.${g}`)}>
            {list.map((s) => (
              <Row key={s.id} s={s} />
            ))}
          </Group>
        ))}
        {processes.length > 0 && (
          <Group title={t("we.group.processes")}>
            {processes.map((w) => (
              <li key={w.id}>
                <button
                  onClick={() => onPick({ node: { process: w.id }, from: w.id })}
                  className="flex w-full items-start gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-hover focus-visible:bg-hover focus-visible:outline-none"
                >
                  <ProcessIcon name={w.icon} size={14} className="mt-0.5 shrink-0 text-muted" />
                  <span className="min-w-0">
                    <span className="block">{processText(w)}</span>
                    <span className="block text-xs text-muted">
                      {t("we.pick.asOneStep")} · {t("we.nested.steps", { n: w.nodes.length })}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </Group>
        )}
        {!shownSteps.length && !processes.length && <p className="px-2 py-3 text-muted">{t("we.nothingFound")}</p>}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3 text-xs text-muted">
        {t("we.pick.none")}
        <Button
          size="sm"
          variant="ghost"
          icon={Sparkles}
          onClick={() => {
            onOpenChange(false);
            openNewStep({ name: query, spec, onCreated: (id) => onPick({ node: { step: id }, from: id }) });
          }}
        >
          {t("we.pick.inWords")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon={Wrench}
          onClick={() => {
            onOpenChange(false);
            // Its place is held in the process until the step is ready.
            askForStep(query, self, (taskId) => onPick({ node: { step: "prompt-steps.pending", params: { description: query, task: taskId } }, from: "pending" }));
          }}
        >
          {t("we.change.askForStep")}
        </Button>
      </div>
    </Dialog>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-2">
      <h3 className="px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-faint">{title}</h3>
      <ul>{children}</ul>
    </section>
  );
}
