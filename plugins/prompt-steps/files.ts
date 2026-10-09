// A step made in words is a Markdown file: a few settings on top, the task for the agent below.
//
//   ---
//   label: Write a changelog
//   mode: answer            # answer: the agent answers once; terminal: it works in the task's terminal until done
//   key: changelog          # its answer is changelog.text, its pick changelog.choice
//   options: ok, needs work # optional: the agent picks one, the process can go a different way for each
//   ---
//   Look at the changes in {{dev.slug}} and write a changelog entry.

export interface PromptStep {
  /** The file's name without .md: the step's id. */
  name: string;
  label: string;
  description: string;
  mode: "answer" | "terminal";
  /** The namespace of what it writes: "<key>.text", "<key>.choice". */
  key: string;
  options: string[];
  prompt: string;
}

const NAME = /^[a-z0-9][a-z0-9-]*$/;

export function parseStep(name: string, text: string): PromptStep {
  if (!NAME.test(name)) throw new Error(`"${name}": lower case letters, digits and dashes`);
  const head: Record<string, string> = {};
  let body = text;
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (match) {
    body = text.slice(match[0].length);
    for (const line of match[1].split(/\r?\n/)) {
      const at = line.indexOf(":");
      if (at > 0) head[line.slice(0, at).trim()] = line.slice(at + 1).replace(/\s+#.*$/, "").trim();
    }
  }
  const key = (head.key || name).toLowerCase().replace(/[^a-z0-9-]+/g, "-") || name;
  return {
    name,
    label: head.label || name,
    description: head.description || "",
    mode: head.mode === "terminal" ? "terminal" : "answer",
    key,
    options: (head.options ?? "")
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean),
    prompt: body.trim(),
  };
}

export function writeStep(step: PromptStep): string {
  const head = [
    `label: ${step.label.replace(/\n/g, " ")}`,
    ...(step.description ? [`description: ${step.description.replace(/\n/g, " ")}`] : []),
    `mode: ${step.mode}`,
    `key: ${step.key}`,
    ...(step.options.length ? [`options: ${step.options.join(", ")}`] : []),
  ];
  return `---\n${head.join("\n")}\n---\n${step.prompt.trim()}\n`;
}

/** The keys a prompt inserts, but the task's own: what the step reads (each may be missing). */
export function insertedKeys(prompt: string): string[] {
  const keys = new Set<string>();
  for (const m of prompt.matchAll(/\{\{\s*([a-z0-9-]+(?:\.[A-Za-z0-9_-]+)+)\s*\}\}/g)) if (!m[1].startsWith("task.")) keys.add(m[1]);
  return [...keys];
}

/** A prompt with the task's title and description and the keys filled in. */
export function fillPrompt(prompt: string, task: { title: string; body: string }, state: Record<string, unknown>): string {
  return prompt
    .replace(/\{\{\s*([a-z0-9.-]+)\s*\}\}/gi, (_, key: string) => {
      if (key === "task.title") return task.title;
      if (key === "task.body") return task.body;
      const value = state[key];
      return value === undefined || value === null ? "" : typeof value === "string" ? value : JSON.stringify(value);
    })
    .trim();
}

/** The option an agent's answer starts with, or undefined. */
export function pickOption(answer: string, options: string[]): string | undefined {
  const first = answer.split("\n").find((l) => l.trim())?.trim().toLowerCase() ?? "";
  return options.find((o) => first === o.toLowerCase()) ?? options.find((o) => first.includes(o.toLowerCase()));
}
