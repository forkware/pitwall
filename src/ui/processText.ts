// Processes in a person's words: names of steps and processes in the user's language, and why one cannot run.
import type { AppState, StepInfo, ProcessInfo, ProcessIssue } from "../sdk/types.ts";
import { known, t } from "./i18n.ts";

/**
 * A step's name in the user's language: plugins add `step:<id>` to their strings (`addStrings`), else its own label.
 * `field` "description" gives its description the same way.
 */
export function stepText(step: Pick<StepInfo, "id" | "label" | "description">, field: "label" | "description" = "label"): string {
  const key = field === "label" ? `step:${step.id}` : `step:${step.id}:description`;
  return known(key) ? t(key) : ((field === "label" ? step.label : step.description) ?? "");
}

/** A process's name or description in the user's language: `process:<id>` in a plugin's strings, else its own. */
export function processText(w: Pick<ProcessInfo, "id" | "label" | "description">, field: "label" | "description" = "label"): string {
  const key = field === "label" ? `process:${w.id}` : `process:${w.id}:description`;
  return known(key) ? t(key) : ((field === "label" ? w.label : w.description) ?? "");
}

/** Words for a state key: what the step that writes or reads it calls it, else the key itself. */
export function keyText(key: string, steps: StepInfo[]): string {
  const bare = key.replace(/\?$/, "");
  const own = `key:${bare}`;
  if (known(own)) return t(own);
  for (const s of steps) if (s.labels[bare]) return s.labels[bare];
  return bare;
}

/** "asks you 2 times", "runs without you". */
export function asksText(n: number): string {
  if (n === 0) return t("asksNever");
  if (n === 1) return t("asksYouOnce");
  return t(plural(n) === "few" ? "asksYouFew" : "asksYou", { n });
}

/** The Russian plural form a number takes ("2 раза", "5 раз"); English needs only one and many. */
export function plural(n: number): "one" | "few" | "many" {
  const tens = n % 100;
  if (tens >= 11 && tens <= 14) return "many";
  if (n % 10 === 1) return "one";
  if (n % 10 >= 2 && n % 10 <= 4) return "few";
  return "many";
}

/** Why the process cannot run, in the user's words. */
export function issueText(issue: ProcessIssue, w: ProcessInfo | undefined, data: AppState | null | undefined): string {
  const steps = data?.processes.steps ?? [];
  const node = (id?: string) => {
    const n = w?.nodes.find((x) => x.id === id);
    if (!n) return id ?? "";
    const step = steps.find((s) => s.id === n.step);
    return n.step && step && n.label === step.label ? stepText(step) : n.label;
  };
  const d = issue.data ?? {};
  const key = `issue.${issue.code}`;
  if (!known(key)) return issue.message;
  const status = data?.statuses.find((s) => s.id === d.status);
  return t(key, {
    node: node(issue.node),
    step: String(d.step ?? ""),
    process: String(d.process ?? ""),
    what: keyText(String(d.key ?? ""), steps),
    status: status?.label ?? String(d.status ?? ""),
    to: String(d.to ?? ""),
    why: String(d.why ?? ""),
    param: String(steps.find((s) => s.id === w?.nodes.find((x) => x.id === issue.node)?.step)?.params[String(d.param)]?.label ?? d.param ?? ""),
    message: issue.message,
  });
}

const own = (key: string, fallback: string) => (known(key) ? t(key) : fallback);

/** A step's question in the user's language: `question:<step>:<id>` in a plugin's strings. */
export function questionText(step: string | undefined, q: { id: string; title: string }): string {
  return step ? own(`question:${step}:${q.id}`, q.title) : q.title;
}

/** An answer's words: `option:<step>:<id>`. */
export function optionText(step: string | undefined, o: { id: string; label: string }): string {
  return step ? own(`option:${step}:${o.id}`, o.label) : o.label;
}

/** A value a step can end with: `outcome:<key>:<value>`, else what the step calls it. */
export function outcomeText(key: string, value: string, fallback: string): string {
  return own(`outcome:${key}:${value}`, fallback);
}

/** A form field's name: `field:<step>:<id>`. */
export function fieldText(step: string | undefined, f: { id: string; label: string }): string {
  return step ? own(`field:${step}:${f.id}`, f.label) : f.label;
}
