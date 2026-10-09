// Texts the basic steps are set up with: answers one per line, and prompts with the task's values in them.
import type { FlowStateView as FlowState, Task } from "#sdk/types";

/** "Done → done" per line: the answer, and the status it moves the task to. The answer is its own id. */
export function options(text: string): { id: string; label: string; status?: string }[] {
  const seen = new Set<string>();
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [label, status] = line.split(/\s*(?:→|->)\s*/);
      return { id: label.trim(), label: label.trim(), ...(status?.trim() ? { status: status.trim() } : {}) };
    })
    .filter((o) => o.id && !seen.has(o.id) && (seen.add(o.id), true));
}

/** What a prompt can insert: the task's title and description and the keys the basic steps write. */
export const slots = ["task.title", "task.body", "agent.answer", "agent.choice", "choice.answer", "command.output"] as const;

/** A prompt with `{{task.title}}`, `{{task.body}}` and `{{<key>}}` filled in; a missing key leaves nothing. */
export function fill(template: string, task: Pick<Task, "title" | "body">, state: FlowState): string {
  return template
    .replace(/\{\{\s*([a-z0-9.-]+)\s*\}\}/gi, (_, key: string) => {
      if (key === "task.title") return task.title;
      if (key === "task.body") return task.body;
      const value = state[key];
      return value === undefined || value === null ? "" : typeof value === "string" ? value : JSON.stringify(value);
    })
    .trim();
}
