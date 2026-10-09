// What the process says to agents. Kept short: every word here is paid for in tokens on each task.
import { toSlug } from "./git.ts";

export interface Refined {
  slug: string;
  title: string;
  /** With the agent's assumptions under "Assumptions". */
  spec: string;
  /** What the agent wants the user to answer before the work starts. */
  questions: Question[];
}

export interface Question {
  question: string;
  /** Answers to pick from (2 to 6); the user may still write their own. */
  options?: string[];
  multiple?: boolean;
  /** The agent's most likely answer, the user takes it with Tab: text, or the options it would pick. */
  suggestion?: string | string[];
}

/** How long a likely answer may be. The agent is asked to keep to it; a longer one is not shown, never cut. */
export const SUGGESTION_MAX = 250;

export const refinePrompt = (request: string) => `Name a development task and restate it. Reply with one JSON object and nothing else:
{"slug": "...", "title": "...", "spec": "...", "assumptions": ["..."], "questions": [{"question": "...", "options": ["..."], "multiple": false, "answer": "..."}]}
slug: 2-5 lowercase English words joined by hyphens, at most 40 characters (a git branch and directory name).
title: a short name for the task in the language of the request.
spec: the request restated in Markdown in its language, with sections Goal, What to do, Done when, How to check. Add nothing the request does not ask for.
assumptions: what you decided yourself where the request is silent and it matters, one short line each, in the language of the request; [] when none.
questions: only real forks: the answer changes the work a lot and there is no sensible default. Usually there are none, and [] is the normal answer. Never ask to have questions; what you can decide yourself goes to assumptions. At most 5, short, in the language of the request; the user answers them before the work starts.
options: when the answer is one of a few, 2-6 short ones (the user can still write their own); leave it out for a free answer. multiple: true when several can be picked.
answer: your most likely answer, at most ${SUGGESTION_MAX} characters: free text, or the option you would pick (a list of them when multiple). The user can take it as is.

Request:
<<<
${request}
>>>`;

/** The agent's JSON, or what can be made of the request without it. */
export function parseRefined(answer: string, request: string): Refined {
  const firstLine = request.trim().split("\n")[0]?.slice(0, 80) || "Task";
  try {
    const json = JSON.parse(answer.slice(answer.indexOf("{"), answer.lastIndexOf("}") + 1));
    const title = typeof json.title === "string" && json.title.trim() ? json.title.trim().slice(0, 120) : firstLine;
    const spec = typeof json.spec === "string" && json.spec.trim() ? json.spec.trim() : request.trim();
    return {
      slug: toSlug(typeof json.slug === "string" ? json.slug : title),
      title,
      spec: withAssumptions(spec, texts(json.assumptions).slice(0, 10)),
      questions: Array.isArray(json.questions) ? json.questions.map(toQuestion).filter((q: Question | undefined): q is Question => !!q).slice(0, 5) : [],
    };
  } catch {
    return { slug: toSlug(firstLine), title: firstLine, spec: request.trim(), questions: [] };
  }
}

/** The strings of a list, trimmed, without empty ones and repeats. */
const texts = (list: unknown): string[] =>
  Array.isArray(list) ? [...new Set(list.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(Boolean))] : [];

/** A question as the agent wrote it: an object with its options and likely answer, or (older answers) a string. */
export function toQuestion(item: unknown): Question | undefined {
  const raw = typeof item === "string" ? { question: item } : item && typeof item === "object" ? (item as Record<string, unknown>) : {};
  const question = typeof raw.question === "string" ? raw.question.trim() : "";
  if (!question) return undefined;
  const out: Question = { question };
  const options = texts(raw.options).slice(0, 6);
  if (options.length >= 2) {
    out.options = options;
    if (raw.multiple === true) out.multiple = true;
  }
  const given = raw.answer ?? raw.suggestion;
  if (out.options) {
    // An answer outside the options is the user's own text, as "Other…" would give it.
    const picks = texts(Array.isArray(given) ? given : [given]).slice(0, out.multiple ? undefined : 1);
    if (picks.length && picks.join(", ").length <= SUGGESTION_MAX) out.suggestion = out.multiple ? picks : picks[0];
  } else if (typeof given === "string" && given.trim() && given.trim().length <= SUGGESTION_MAX) {
    out.suggestion = given.trim();
  }
  return out;
}

/** The spec with what the agent decided itself, for the user to see and correct. */
export function withAssumptions(spec: string, assumptions: string[]): string {
  return assumptions.length ? `${spec}\n\n## Assumptions\n\n${assumptions.map((a) => `- ${a}`).join("\n")}` : spec;
}

/** The spec with the user's answers to the agent's questions; picked options are joined with commas. */
export function withAnswers(spec: string, questions: Question[], answers: Record<string, string | string[] | undefined>): string {
  const answered = questions
    .map(({ question: q }, i) => {
      const a = answers[`q${i}`];
      return [q, (Array.isArray(a) ? a.map((v) => v.trim()).filter(Boolean).join(", ") : a)?.trim()] as const;
    })
    .filter(([, a]) => a)
    .map(([q, a]) => `- ${q}\n  ${a!.replace(/\n/g, "\n  ")}`);
  return answered.length ? `${spec}\n\n## Clarifications\n\n${answered.join("\n")}` : spec;
}

export function codePrompt(spec: string, where: { branch?: string; base?: string }): string {
  const place = where.branch
    ? `You work in a git worktree on branch ${where.branch}, made from ${where.base}. Commit as you like; the app commits what is left and merges it into ${where.base} itself.`
    : "";
  return `${spec}

${place}
When the work is finished, run: pitwall done "<what you did, one line>"
The app then runs the tests and gives you what fails.
If the task becomes clearer, rewrite its description: pitwall spec "<markdown>" (or pipe a file into it).`.replace(/\n{3,}/g, "\n\n");
}

export const nudge = 'Are you finished? If so, run: pitwall done "<what you did, one line>". If not, carry on.';

export const testsFailed = (command: string, output: string) =>
  `The tests failed (\`${command}\`):\n\n${output}\n\nFix it, then run pitwall done again.`;

export const userComment = (comment: string) =>
  `The user tried your work on the dev stand and sent it back:\n\n${comment}\n\nWhen it is fixed, run pitwall done again.`;

export const mergeConflict = (base: string, details: string) =>
  `Your branch conflicts with ${base}. Merge ${base} into your branch, resolve the conflicts and commit.\n\n${details}\n\nThen run pitwall done again.`;

export const devTestsFailed = (base: string, command: string, output: string) =>
  `After merging into ${base} the tests failed there (\`${command}\`), so the merge was taken back. Merge ${base} into your branch and fix it:\n\n${output}\n\nThen run pitwall done again.`;

/** What the "Fix" button under a failed install asks a Customize the app agent to do. */
export const installFailed = (dir: string, output: string) => `The development process (plugin dev-flow) could not install the dependencies of a new task worktree, ${dir}. The task's agent works there without them.

Find out why. If the cause is in this app (how dev-flow picks or runs the install command, plugins/dev-flow/shell.ts installCommand), fix it here with a test. If it is in that repository or on this machine (lockfile, package manager missing, network), say what to do, and do it if the user agrees. Check: the install command succeeds in ${dir}.

Output:
<<<
${output}
>>>`;
