// The step library: every step there is, grouped by who does it, with what it gets and gives and which processes
// use it. The user's own steps in words can be changed and deleted; a step with code is changed by an agent.
import { Pencil, Search, Sparkles, Trash2, Wrench } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  Button,
  confirm,
  IconButton,
  Input,
  keyText,
  onEvent,
  rpc,
  stepText,
  t,
  toast,
  useUi,
  ProcessIcon,
  processText,
  type StepInfo,
  type ProcessInfo,
} from "#sdk/ui";
import { askForStep } from "./askForStep.tsx";
import { openNewStep, type PromptStepInfo } from "./newStep.tsx";
import { openProcess } from "./Catalog.tsx";
import { asNode } from "./specs.ts";

const GROUPS = ["you", "agent", "tests", "git", "github", "other"] as const;
const groupOf = (s: StepInfo) =>
  s.group && (GROUPS as readonly string[]).includes(s.group) ? s.group : s.role === "agent" ? "agent" : s.role === "you" ? "you" : "other";

/** The processes each step stands in, inner processes' too. */
function usedIn(defs: ProcessInfo[]): Map<string, ProcessInfo[]> {
  const map = new Map<string, ProcessInfo[]>();
  for (const w of defs) {
    for (const n of Object.values(w.spec.nodes)) {
      const step = asNode(n).step;
      if (!step) continue;
      const list = map.get(step) ?? [];
      if (!list.includes(w)) map.set(step, [...list, w]);
    }
  }
  return map;
}

function usePromptSteps(): PromptStepInfo[] {
  const [list, setList] = useState<PromptStepInfo[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => void rpc<PromptStepInfo[]>("prompt-steps", "list").then((x) => alive && setList(x)).catch(() => {});
    load();
    const off = onEvent((name) => name === "step.registered" && load());
    return () => {
      alive = false;
      off();
    };
  }, []);
  return list;
}

export function StepsLibrary() {
  const steps = useUi((s) => s.data?.processes.steps ?? []);
  const defs = useUi((s) => s.data?.processes.defs ?? []);
  const own = usePromptSteps();
  const [query, setQuery] = useState("");
  const uses = useMemo(() => usedIn(defs), [defs]);
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = steps
    .filter((s) => s.id !== "prompt-steps.pending")
    .filter((s) => words.every((w) => `${stepText(s)} ${stepText(s, "description")} ${s.label}`.toLowerCase().includes(w)));
  return (
    <div className="px-4 py-4 sm:px-6 sm:py-5">
      <p className="mb-4 max-w-2xl text-muted">{t("we.lib.hint")}</p>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-72">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
          <Input className="h-8 pl-8" placeholder={t("we.pick.find")} value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <Button size="sm" icon={Sparkles} onClick={() => openNewStep({})}>
          {t("we.pick.inWords")}
        </Button>
        <Button size="sm" variant="ghost" icon={Wrench} onClick={() => askForStep("")}>
          {t("we.change.askForStep")}
        </Button>
      </div>
      {GROUPS.map((g) => {
        const list = shown.filter((s) => groupOf(s) === g);
        if (!list.length) return null;
        return (
          <section key={g} className="mb-6 max-w-4xl">
            <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-faint">{t(`we.group.${g}`)}</h2>
            <ul className="divide-y divide-line rounded-lg border border-line bg-panel">
              {list.map((s) => (
                <StepRow key={s.id} step={s} steps={steps} used={uses.get(s.id) ?? []} own={own.find((p) => `prompt-steps.${p.name}` === s.id)} />
              ))}
            </ul>
          </section>
        );
      })}
      {!shown.length && <p className="text-muted">{t("we.nothingFound")}</p>}
    </div>
  );
}

function StepRow({ step, steps, used, own }: { step: StepInfo; steps: StepInfo[]; used: ProcessInfo[]; own?: PromptStepInfo }) {
  const [open, setOpen] = useState(false);
  const words = (keys: string[]) => (keys.length ? keys.map((k) => keyText(k, steps)).join(", ") : t("we.card.nothing"));
  return (
    <li className="px-3 py-2">
      <div className="flex items-start gap-2.5">
        <ProcessIcon name={step.icon ?? (step.role === "agent" ? "bot" : step.role === "you" ? "user-round" : "cog")} size={14} className="mt-0.5 shrink-0 text-muted" />
        <button className="min-w-0 flex-1 text-left" onClick={() => setOpen(!open)} aria-expanded={open}>
          <span className="block font-medium">{stepText(step)}</span>
          {stepText(step, "description") && <span className="block text-xs text-muted">{stepText(step, "description")}</span>}
          <span className="block text-[11px] text-faint">
            {own ? t("we.lib.yours") : t("we.fromPlugin", { plugin: step.plugin })} ·{" "}
            {used.length ? t("we.lib.usedIn", { n: used.length }) : t("we.lib.unused")}
          </span>
        </button>
        <span className="flex shrink-0 items-center gap-0.5">
          {own ? (
            <>
              <IconButton icon={Pencil} label={t("we.lib.change")} onClick={() => openNewStep({ existing: own })} />
              <IconButton
                icon={Trash2}
                label={t("delete")}
                onClick={() =>
                  used.length
                    ? toast(t("we.lib.usedCannotDelete", { n: used.length }), "error")
                    : confirm({
                        title: t("we.lib.deleteTitle", { name: stepText(step) }),
                        confirm: t("delete"),
                        onConfirm: () => void rpc("prompt-steps", "remove", { name: own.name }).catch((e) => toast((e as Error).message, "error")),
                      })
                }
              />
            </>
          ) : (
            <IconButton icon={Wrench} label={t("we.lib.changeCode")} onClick={() => askForStep(t("we.lib.changeRequest", { step: step.id }))} />
          )}
        </span>
      </div>
      {open && (
        <div className="ml-6 mt-2 space-y-1 text-xs text-muted">
          <div>
            <span className="text-faint">{t("we.card.gets")}:</span> {words(step.reads)}
          </div>
          <div>
            <span className="text-faint">{t("we.card.gives")}:</span> {words(step.writes)}
          </div>
          {step.sideEffects && <div>{t("we.card.sideEffects")}</div>}
          {used.length > 0 && (
            <div>
              <span className="text-faint">{t("we.lib.in")}:</span>{" "}
              {used.map((w, i) => (
                <span key={w.id}>
                  {i > 0 && ", "}
                  <button className="text-text hover:underline" onClick={() => openProcess(w.id)}>
                    {processText(w)}
                  </button>
                </span>
              ))}
            </div>
          )}
          {own && <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-bg p-2 font-mono text-[11px]">{own.prompt}</pre>}
        </div>
      )}
    </li>
  );
}
