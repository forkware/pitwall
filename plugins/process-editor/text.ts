// Steps, values and questions in the user's language. Plugins add their words with addStrings:
// `step:<id>`, `outcome:<key>:<value>`, `question:<step id>:<question id>`, `option:<step id>:<option id>`.
import { getState, known, statusLabel, stepText, t, type QuestionInfo, type StepInfo, type ProcessNodeInfo } from "#sdk/ui";
import { valueLabel, type RecipeRow } from "./model.ts";

export const own = (key: string, fallback: string) => (known(key) ? t(key) : fallback);

export function stepName(step: StepInfo | undefined, fallback = ""): string {
  return step ? stepText(step) : fallback;
}

/** A node's name in the recipe: what the process calls it, else its step's name. */
export function nodeName(row: Pick<RecipeRow, "spec" | "step" | "info">): string {
  if (row.spec.label) return row.spec.label;
  if (row.step) return stepText(row.step);
  return row.info.label;
}

/** How a step words a value it can end with: "passed", "Ready to deploy". */
export function valueWords(step: StepInfo | undefined, key: string, value: string, node?: Pick<ProcessNodeInfo, "outcomes" | "questions">): string {
  // The plugin's words in the user's language first; a node's own values (its parameters made them, "Ready → done")
  // are the user's words already; then the step's question options, translated.
  const outcome = `outcome:${key}:${value}`;
  if (known(outcome)) return t(outcome);
  for (const q of step?.questions ?? []) {
    if (q.options?.some((o) => o.id === value) && step) {
      const option = `option:${step.id}:${value}`;
      if (known(option)) return t(option);
    }
  }
  const own = node?.outcomes?.[key]?.[value];
  if (own) return own;
  return valueLabel(step, key, value, node);
}

export function questionTitle(step: StepInfo | undefined, q: QuestionInfo): string {
  return step ? own(`question:${step.id}:${q.id}`, q.title) : q.title;
}

export function optionLabel(step: StepInfo | undefined, option: { id: string; label: string }): string {
  return step ? own(`option:${step.id}:${option.id}`, option.label) : option.label;
}

export function whenText(step: StepInfo | undefined, q: QuestionInfo): string {
  return q.when ? (step ? own(`question:${step.id}:${q.id}:when`, q.when) : q.when) : "";
}

export function statusName(id: string | undefined): string {
  if (!id) return "";
  return statusLabel(getState().data?.statuses.find((s) => s.id === id), id);
}

/** A parameter's name in the user's language: `param:<step id>:<key>` in a plugin's strings. */
export function paramLabel(step: StepInfo | undefined, key: string): string {
  const def = step?.params[key];
  return step ? own(`param:${step.id}:${key}`, def?.label ?? key) : key;
}

/** A form field's name: `field:<step id>:<field id>` in a plugin's strings. */
export function fieldLabel(step: StepInfo | undefined, field: { id: string; label: string }): string {
  return step ? own(`field:${step.id}:${field.id}`, field.label) : field.label;
}

export function paramDescription(step: StepInfo | undefined, key: string): string | undefined {
  const def = step?.params[key];
  if (!step || !def?.description) return def?.description;
  return own(`param:${step.id}:${key}:description`, def.description);
}
