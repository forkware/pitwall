// An automation and its process: what to give the process (its first form), what to answer when the process asks
// and nobody is there, and in one sentence what the user will find when it ran.
import type { AutomationAnswer, AutomationConfig, StepInfo, ProcessInfo } from "../../sdk/types.ts";
import { t } from "../i18n.ts";
import { cx } from "../kit/index.tsx";
import { keyText, optionText, outcomeText, questionText, stepText } from "../processText.ts";

/** A question the process can ask, where: "<node path>:<question id>" is how an automation answers it. */
export interface ProcessQuestion {
  key: string;
  /** "6", or "2.1" inside a process run as a step. */
  n: string;
  step?: string;
  stepLabel: string;
  question: ProcessInfo["nodes"][number]["questions"][number];
  /** The first form of the process: the automation fills it from its fields. */
  first: boolean;
}

/** The questions of a process in the order of its recipe, its inner processes' too. */
export function processQuestions(def: ProcessInfo, defs: ProcessInfo[], steps: StepInfo[]): ProcessQuestion[] {
  const list: ProcessQuestion[] = [];
  def.nodes.forEach((node, i) => {
    if (node.skip) return;
    for (const q of node.questions) {
      const path = q.node ? `${node.id}/${q.node}` : node.id;
      const stepId = q.step ?? (node.step || undefined);
      const step = steps.find((s) => s.id === stepId);
      let n = String(i + 1);
      if (q.node && node.process) {
        const inner = defs.find((d) => d.id === node.process);
        const at = inner?.nodes.findIndex((x) => x.id === q.node!.split("/")[0]) ?? -1;
        if (at >= 0) n = `${i + 1}.${at + 1}`;
      }
      list.push({
        key: `${path}:${q.id}`,
        n,
        step: stepId,
        stepLabel: step ? stepText(step) : node.label,
        question: q,
        first: false,
      });
    }
  });
  const first = list.find((x) => x.question.kind === "form");
  if (first && list.indexOf(first) === 0) first.first = true;
  return list;
}

/** What a key a step of the process writes can be, to answer only when it is so: "if the tests passed". */
export function conditions(def: ProcessInfo, steps: StepInfo[]): { key: string; value: string; label: string }[] {
  const seen = new Set<string>();
  const list: { key: string; value: string; label: string }[] = [];
  for (const node of def.nodes) {
    const step = steps.find((s) => s.id === node.step);
    const outcomes = { ...(step?.outcomes ?? {}), ...node.outcomes };
    for (const [key, values] of Object.entries(outcomes)) {
      for (const [value, words] of Object.entries(values)) {
        const id = `${key}=${value}`;
        if (seen.has(id)) continue;
        seen.add(id);
        list.push({ key, value, label: `${step ? stepText(step) : keyText(key, steps)}: ${outcomeText(key, value, words)}` });
      }
    }
  }
  return list;
}

/** One sentence: what the user finds after a run. */
export function summary(questions: ProcessQuestion[], answers: AutomationConfig["questions"], firstFilled: boolean): string {
  const waits = questions.filter((q) => {
    if (q.first) return !firstFilled;
    if (q.question.when) return false;
    const rule = answers[q.key];
    return !rule || rule.answer === "wait";
  });
  // Asked only sometimes, or answered only when a condition holds: then the task may wait.
  const sometimes = questions.filter((q) => {
    if (q.first) return false;
    const rule = answers[q.key];
    return (q.question.when && (!rule || rule.answer === "wait")) || !!rule?.when;
  });
  if (!waits.length) return sometimes.length ? t("aq.summaryAloneSometimes") : t("aq.summaryAlone");
  const first = waits[0];
  if (first.first) return t("aq.summaryForm");
  return t("aq.summaryWaits", { n: first.n, step: first.stepLabel });
}

const field =
  "h-8 rounded-md border border-line bg-bg px-2 text-[13px] outline-none focus:border-accent focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_20%,transparent)]";

/** Each question with what to answer when nobody is there. */
export function QuestionAnswers({
  questions,
  value,
  onChange,
  seen,
  def,
  steps,
}: {
  questions: ProcessQuestion[];
  value: AutomationConfig["questions"];
  onChange: (next: AutomationConfig["questions"]) => void;
  seen: string[];
  def: ProcessInfo;
  steps: StepInfo[];
}) {
  const when = conditions(def, steps);
  const set = (key: string, rule: AutomationAnswer | null) => {
    const next = { ...value };
    if (!rule || rule.answer === "wait") delete next[key];
    else next[key] = rule;
    onChange(next);
  };
  if (!questions.length) return <p className="text-muted">{t("aq.none")}</p>;
  return (
    <ul className="space-y-2">
      {questions.map((q) => {
        const rule = value[q.key];
        const isNew = seen.length > 0 && !seen.includes(q.key) && !q.first;
        return (
          <li key={q.key} className="grid gap-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] sm:items-start sm:gap-3">
            <div className="min-w-0">
              <span className="text-faint">{q.n} </span>
              {questionText(q.step, q.question)}
              {isNew && <span className="ml-1.5 rounded bg-[color-mix(in_srgb,var(--s-amber)_18%,transparent)] px-1 text-[11px] text-[var(--s-amber)]">{t("aq.new")}</span>}
              {q.question.when && <div className="text-xs text-faint">{t("aq.sometimes")}</div>}
            </div>
            {q.first ? (
              <div className="text-xs text-muted">{t("aq.firstForm")}</div>
            ) : q.question.kind === "form" ? (
              <select className={cx(field, "w-full")} value={rule?.answer === "stop" ? "stop" : "wait"} onChange={(e) => set(q.key, { answer: e.target.value })}>
                <option value="wait">{t("aq.wait")}</option>
                <option value="stop">{t("aq.stop")}</option>
              </select>
            ) : (
              <div className="space-y-1">
                <select
                  aria-label={questionText(q.step, q.question)}
                  className={cx(field, "w-full")}
                  value={rule?.answer ?? "wait"}
                  onChange={(e) => set(q.key, { answer: e.target.value, ...(rule?.when ? { when: rule.when } : {}) })}
                >
                  <option value="wait">{t("aq.wait")}</option>
                  {(q.question.options ?? []).map((o) => (
                    <option key={o.id} value={o.id}>
                      {t("aq.answer", { answer: optionText(q.step, o) })}
                    </option>
                  ))}
                  <option value="stop">{t("aq.stop")}</option>
                </select>
                {rule && rule.answer !== "wait" && rule.answer !== "stop" && when.length > 0 && (
                  <select
                    aria-label={t("aq.when")}
                    className={cx(field, "w-full")}
                    value={rule.when ? `${rule.when.key}=${rule.when.value}` : ""}
                    onChange={(e) => {
                      const [key, ...rest] = e.target.value.split("=");
                      set(q.key, { answer: rule.answer, ...(e.target.value ? { when: { key, value: rest.join("=") } } : {}) });
                    }}
                  >
                    <option value="">{t("aq.always")}</option>
                    {when.map((c) => (
                      <option key={`${c.key}=${c.value}`} value={`${c.key}=${c.value}`}>
                        {t("aq.if", { condition: c.label })}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** The questions of the process this automation has not decided about yet: added after it was set up. */
export function newQuestions(questions: ProcessQuestion[], seen: string[]): ProcessQuestion[] {
  if (!seen.length) return [];
  return questions.filter((q) => !q.first && !seen.includes(q.key));
}

/** Whether the automation's answers fill the process's first form: its required fields, title and body by default. */
export function fillsFirstForm(first: ProcessQuestion | undefined, answers: Record<string, string>): boolean {
  if (!first?.first) return true;
  const fields = first.question.fields ?? [];
  return fields.every((f) => !f.required || answers[f.id]?.trim() || f.id === "title" || f.id === "body" || fields.length === 1);
}
