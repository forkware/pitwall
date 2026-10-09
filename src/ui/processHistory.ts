// What a task's process did and will do, as the details panel tells it: no words here, only the facts behind them.
import type { Session, ProcessInfo, ProcessRun, ProcessSpec, ProcessTraceEntry } from "../sdk/types.ts";

export interface HistoryItem {
  entry: ProcessTraceEntry;
  /** The outer process's node the entry ran in. */
  node: string;
  /** It ran a node that came earlier than the one before it: the task went back. */
  back: boolean;
  /** The status the task took with this step, when it differs from the step before. */
  stage: string | null;
}

const outer = (node: string) => node.split("/")[0];

/** The trace in order, with where the task went back and where its status changed. Skipped steps are left out. */
export function historyItems(trace: ProcessTraceEntry[], def: Pick<ProcessInfo, "nodes"> | undefined): HistoryItem[] {
  const order = def?.nodes.map((n) => n.id) ?? [];
  const statusOf = (node: string) => def?.nodes.find((n) => n.id === node)?.status ?? null;
  const items: HistoryItem[] = [];
  let lastNode: string | null = null;
  let lastStatus: string | null = null;
  for (const entry of trace) {
    if (entry.result === "skipped") continue;
    const node = outer(entry.node);
    const back = lastNode !== null && order.indexOf(node) >= 0 && order.indexOf(node) < order.indexOf(lastNode);
    const status = statusOf(node);
    const stage = status && status !== lastStatus ? status : null;
    if (status) lastStatus = status;
    items.push({ entry, node, back, stage });
    lastNode = node;
  }
  return items;
}

const targets = (to: ProcessSpec["edges"][number][1]): string[] =>
  typeof to === "string" ? [to] : "targets" in to ? to.targets : [...Object.values(to.cases), ...(to.else ? [to.else] : [])];

/**
 * The nodes the process can still reach from the current one, in the order they come:
 * going back (to fix something) is not "next", so only nodes declared after the current one count.
 */
export function nextNodes(spec: Pick<ProcessSpec, "nodes" | "edges"> | undefined, current: string | null): string[] {
  if (!spec || !current) return [];
  const order = Object.keys(spec.nodes);
  const from = order.indexOf(current);
  const seen = new Set<string>([current]);
  const queue = [current];
  while (queue.length) {
    const node = queue.shift()!;
    for (const [src, to] of spec.edges) {
      if (src !== node) continue;
      for (const next of targets(to)) {
        if (seen.has(next) || !order.includes(next) || order.indexOf(next) < from) continue;
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return order.filter((id) => id !== current && seen.has(id));
}

/** "1 ч 12 мин", "12 мин", "40 с": the two largest units of a duration. */
export function duration(ms: number, units: { h: string; m: string; s: string }): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return m ? `${h} ${units.h} ${m} ${units.m}` : `${h} ${units.h}`;
  if (m) return `${m} ${units.m}`;
  return `${s} ${units.s}`;
}

/**
 * The process waits for the task's agent rather than for the user: one answer ("The agent finished") while
 * an agent of the task runs. The header then shows it working, and the answer goes to the task's menu.
 */
export function waitsForAgent(run: Pick<ProcessRun, "state" | "request">, sessions: Pick<Session, "state">[]): boolean {
  const request = run.request;
  return (
    run.state === "waiting" &&
    request?.kind === "choice" &&
    request.options.length === 1 &&
    !request.options[0].status &&
    sessions.some((s) => s.state === "running")
  );
}

/** What a step returned that is worth reading as text: long or multiline strings (a test run's output, say). */
export function outputTexts(output: Record<string, unknown> | null): { key: string; text: string }[] {
  return Object.entries(output ?? {})
    .filter(([, v]) => typeof v === "string" && (v.length > 80 || v.includes("\n")))
    .map(([key, v]) => ({ key, text: v as string }));
}

/** The first line of a message, for a header that has room for one. */
export function firstLine(text: string | null | undefined, max = 120): string {
  const line = (text ?? "").trim().split("\n")[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** A step that ended with a "no" its process branches on (tests passed: false): it went, but not well. */
export function endedBadly(output: Record<string, unknown> | null, outcomes: Record<string, Record<string, string>> | undefined): boolean {
  return Object.entries(output ?? {}).some(([key, value]) => !!outcomes?.[key] && (value === false || value === "false"));
}
