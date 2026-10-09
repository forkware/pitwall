// What the editor tells the agent that changes a process in words, and how it reads the answer.
import type { StatusDef, StepInfo, ProcessInfo, ProcessSpec } from "#sdk/types";

/** What the agent may answer, as JSON. */
export type ChangeAnswer =
  | { spec: ProcessSpec; note?: string }
  | { question: string }
  | { needsCode: string };

const stepLine = (s: StepInfo) =>
  JSON.stringify({
    id: s.id,
    label: s.label,
    ...(s.description ? { does: s.description } : {}),
    who: s.role,
    ...(s.reads.length ? { reads: s.reads } : {}),
    ...(s.writes.length ? { writes: s.writes } : {}),
    ...(Object.keys(s.params).length ? { params: Object.fromEntries(Object.entries(s.params).map(([k, p]) => [k, `${p.type}: ${p.label}`])) } : {}),
    ...(Object.keys(s.outcomes).length ? { branchOn: s.outcomes } : {}),
    ...(s.questions.length ? { asks: s.questions.map((q) => ({ id: q.id, title: q.title, options: q.options?.map((o) => o.id) })) } : {}),
  });

export function changePrompt(options: {
  spec: ProcessSpec;
  request: string;
  steps: StepInfo[];
  processes: ProcessInfo[];
  statuses: StatusDef[];
  /** The step the user points at: "Change this step" on a task. */
  node?: string;
  lang: string;
}): string {
  const { spec, request, steps, processes, statuses, node, lang } = options;
  const target = node ? spec.nodes[node] : undefined;
  return [
    "You change a process of the Pitwall app (a process: what happens to a task) the way the user asks.",
    "",
    "A process is JSON:",
    '- "nodes": its steps in the order of its recipe, name → step id, or { "step": id, "params": {...}, "status": status id, "label": "its name in the recipe", "skip": true } or { "process": id of another process run as one step, "in": {...}, "out": {...} }.',
    '- "edges": [from, to] pairs, "start" and "end" being its ends; a branch is [from, { "on": "<a key the step writes>", "cases": { "<value>": "<node>" }, "else": "<node>" }].',
    '- "doneStatus": the task\'s status at the end. Keep "id", "overrides" and "base" as they are.',
    "Every key a step reads must be written by a step before it. Every step must lead to the end.",
    "",
    "Steps you can use (only these ids):",
    ...steps.map(stepLine),
    "",
    `Other processes that can run as one step: ${processes.filter((w) => !w.template).map((w) => `${w.id} (${w.label})`).join(", ") || "none"}.`,
    `Statuses: ${statuses.map((s) => `${s.id} (${s.label})`).join(", ")}.`,
    "",
    "The process now:",
    JSON.stringify(spec, null, 1),
    "",
    ...(node ? [`The user points at the step "${node}": ${JSON.stringify(target)}.`, ""] : []),
    `The user asks: ${JSON.stringify(request)}`,
    "",
    "Answer with JSON only, one of:",
    '{ "spec": <the whole process, changed>, "note": "<one or two sentences: how you understood the request and what you assumed>" }',
    '{ "question": "<what you need to know to do it>" }',
    '{ "needsCode": "<the step that is missing: what it should do>" } when no listed step can do what is asked.',
    `Write "note", "question" and "needsCode" in the user's language (${lang}). Change only what the request needs. Do not change any files.`,
  ].join("\n");
}

export function fixPrompt(problems: string[]): string {
  return [
    "Your process has problems the app found:",
    ...problems.map((p) => `- ${p}`),
    "Fix them and answer again with the same JSON.",
  ].join("\n");
}

export function refinePrompt(base: string, previous: string | null, words: string): string {
  return [base, "", ...(previous ? ["Your previous answer:", previous, ""] : []), `The user adds: ${JSON.stringify(words)}`, "Answer again with the same JSON."].join("\n");
}

/** The JSON in an agent's answer: fenced, or the outermost braces. */
export function parseAnswer(text: string): ChangeAnswer {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1];
  const body = fenced ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new Error("The agent's answer is not JSON");
  }
  if (!value || typeof value !== "object") throw new Error("The agent's answer is not an object");
  const v = value as Record<string, unknown>;
  if (typeof v.question === "string") return { question: v.question };
  if (typeof v.needsCode === "string") return { needsCode: v.needsCode };
  if (v.spec && typeof v.spec === "object") return { spec: v.spec as ProcessSpec, note: typeof v.note === "string" ? v.note : undefined };
  throw new Error('The agent answered neither "spec", "question" nor "needsCode"');
}
