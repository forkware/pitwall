// Search of tasks: a full-text index in memory (SQLite FTS5) and the filters the palette and the page use.
import { DatabaseSync } from "node:sqlite";
import type { PluginContext, Task } from "#sdk/server";

/** Which tasks: those in the tree, the archived ones, or both. */
export type ArchiveScope = "active" | "archived" | "all";

export interface SearchInput {
  /** Words, and prefixes: in:<folder>, status:<id>, is:archived|waiting|asking|failed|working|open|done, from:schedule|webhook|manual, flow:<process>, created:7d, updated:30d. */
  query?: string;
  archive?: ArchiveScope;
  folderId?: string;
  status?: string;
  process?: string;
  /** "manual", "schedule", "webhook", or an automation's id. */
  source?: string;
  state?: "waiting" | "asking" | "failed" | "working";
  /** Days back. */
  created?: number;
  updated?: number;
  /** Also in what the agents printed. */
  logs?: boolean;
  limit?: number;
}

export interface SearchHit {
  task: Task & { folderPath: string };
  /** The text around the match, the match between « and ». */
  snippet: string | null;
}

export interface SearchResult {
  hits: SearchHit[];
  /** When the archive was left out: how many archived tasks match too. */
  archived: number;
}

const DAY = 24 * 60 * 60 * 1000;
/** How much of an agent's log is searched: its end. */
const LOG_CHARS = 200_000;

/** Every string in a plugin's data, joined: dev-flow's spec, an issue number, a webhook's payload. */
export function metaText(meta: Record<string, unknown>): string {
  const out: string[] = [];
  const walk = (v: unknown, depth: number) => {
    if (depth > 6 || out.length > 400) return;
    if (typeof v === "string") out.push(v);
    else if (typeof v === "number") out.push(String(v));
    else if (Array.isArray(v)) v.forEach((x) => walk(x, depth + 1));
    else if (v && typeof v === "object") Object.values(v).forEach((x) => walk(x, depth + 1));
  };
  walk(meta, 0);
  return out.join(" ");
}

/** Words for FTS5: each a prefix, all of them needed. */
export function ftsQuery(text: string): string | null {
  const words = text.match(/[\p{L}\p{N}_#-]+/gu)?.map((w) => w.replace(/^[#-]+|-+$/g, "")).filter(Boolean) ?? [];
  if (words.length === 0) return null;
  return words.map((w) => `"${w.replace(/"/g, '""')}"*`).join(" AND ");
}

/** Takes the prefixes out of a query into filters; what is left are the words. */
export function parseQuery(query: string, input: SearchInput = {}): { words: string; filters: SearchInput } {
  const filters: SearchInput = { ...input };
  const words: string[] = [];
  for (const token of query.match(/\S+:"[^"]*"|\S+/g) ?? []) {
    const m = /^(in|status|is|from|flow|created|updated):(.+)$/i.exec(token);
    if (!m) {
      words.push(token);
      continue;
    }
    const value = m[2].replace(/^"|"$/g, "");
    switch (m[1].toLowerCase()) {
      case "in":
        filters.folderId = `name:${value}`;
        break;
      case "status":
        filters.status = value;
        break;
      case "is":
        if (value === "archived") filters.archive = "archived";
        else if (["waiting", "asking", "failed", "working"].includes(value)) filters.state = value as SearchInput["state"];
        else filters.status = `category:${value === "done" ? "done" : value === "active" ? "active" : "open"}`;
        break;
      case "from":
        filters.source = value === "cron" ? "schedule" : value;
        break;
      case "flow":
        filters.process = value;
        break;
      case "created":
      case "updated":
        filters[m[1].toLowerCase() as "created" | "updated"] = Number.parseInt(value, 10) || undefined;
        break;
    }
  }
  return { words: words.join(" "), filters };
}

export class SearchIndex {
  private db = new DatabaseSync(":memory:");
  private logKeys = new Map<string, string>();
  private ctx: PluginContext;

  constructor(ctx: PluginContext) {
    this.ctx = ctx;
    this.db.exec(`
      CREATE VIRTUAL TABLE tasks USING fts5(id UNINDEXED, title, body, meta, folder, tokenize = "unicode61 remove_diacritics 2");
      CREATE VIRTUAL TABLE logs USING fts5(session UNINDEXED, task UNINDEXED, text, tokenize = "unicode61 remove_diacritics 2");
    `);
  }

  /** Indexes all tasks again. */
  rebuild(): void {
    this.db.exec("DELETE FROM tasks");
    for (const task of this.ctx.tasks.list(undefined, { archived: "all" })) this.put(task);
  }

  put(task: Task): void {
    this.remove(task.id);
    // A process editor's trial run is not a task of the user's.
    if (task.meta.trial) return;
    this.db
      .prepare("INSERT INTO tasks (id, title, body, meta, folder) VALUES (?, ?, ?, ?, ?)")
      .run(task.id, task.title, task.body, metaText(task.meta), this.path(task.folderId));
  }

  remove(taskId: string): void {
    this.db.prepare("DELETE FROM tasks WHERE id = ?").run(taskId);
    this.db.prepare("DELETE FROM logs WHERE task = ?").run(taskId);
  }

  private path(folderId: string): string {
    return this.ctx.folders
      .chain(folderId)
      .reverse()
      .map((f) => f.name)
      .join(" / ");
  }

  /** Agents' logs that changed since they were indexed. */
  private refreshLogs(): void {
    for (const s of this.ctx.agents.sessions()) {
      const key = `${s.state}:${s.endedAt ?? ""}:${s.lastOutputAt ?? ""}`;
      if (this.logKeys.get(s.id) === key) continue;
      this.logKeys.set(s.id, key);
      this.db.prepare("DELETE FROM logs WHERE session = ?").run(s.id);
      const text = this.ctx.agents.log(s.id).slice(-LOG_CHARS);
      if (text) this.db.prepare("INSERT INTO logs (session, task, text) VALUES (?, ?, ?)").run(s.id, s.taskId, text);
    }
  }

  search(input: SearchInput): SearchResult {
    const { words, filters } = parseQuery(input.query ?? "", input);
    const fts = ftsQuery(words);
    const limit = Math.min(input.limit ?? 100, 500);
    const all = this.ctx.tasks.list(undefined, { archived: "all" });
    const byId = new Map(all.map((t) => [t.id, t]));

    // Matches, best first, with a snippet.
    let ranked: { id: string; snippet: string | null }[];
    if (fts) {
      const rows = this.db
        .prepare(
          `SELECT id, snippet(tasks, -1, '«', '»', '…', 10) AS snippet FROM tasks WHERE tasks MATCH ? ORDER BY bm25(tasks, 0, 10, 3, 2, 2) LIMIT 2000`,
        )
        .all(fts) as { id: string; snippet: string }[];
      ranked = rows.map((r) => ({ id: r.id, snippet: r.snippet }));
      if (filters.logs) {
        this.refreshLogs();
        const seen = new Set(ranked.map((r) => r.id));
        const logRows = this.db
          .prepare(`SELECT task, snippet(logs, 2, '«', '»', '…', 10) AS snippet FROM logs WHERE logs MATCH ? ORDER BY rank LIMIT 500`)
          .all(fts) as { task: string; snippet: string }[];
        for (const r of logRows) if (!seen.has(r.task)) (seen.add(r.task), ranked.push({ id: r.task, snippet: r.snippet }));
      }
    } else {
      ranked = [...all].sort((a, b) => b.updatedAt - a.updatedAt).map((t) => ({ id: t.id, snippet: null }));
    }

    const pass = this.filter(filters);
    const scope = filters.archive ?? "active";
    const hits: SearchHit[] = [];
    let archived = 0;
    for (const { id, snippet } of ranked) {
      const task = byId.get(id);
      if (!task || !pass(task)) continue;
      const isArchived = !!task.archivedAt;
      if (scope === "active" && isArchived) {
        archived++;
        continue;
      }
      if (scope === "archived" && !isArchived) continue;
      // The title's own match needs no snippet.
      const shown = snippet && !snippet.startsWith("«") && snippet.replace(/[«»]/g, "") !== task.title ? snippet : null;
      if (hits.length < limit) hits.push({ task: { ...task, folderPath: this.path(task.folderId) }, snippet: shown });
    }
    return { hits, archived };
  }

  /** The filters as one predicate. */
  private filter(f: SearchInput): (task: Task) => boolean {
    const ctx = this.ctx;
    let folders: Set<string> | null = null;
    if (f.folderId) {
      const roots = f.folderId.startsWith("name:")
        ? ctx.folders.list().filter((x) => x.name.toLowerCase() === f.folderId!.slice(5).toLowerCase()).map((x) => x.id)
        : [f.folderId];
      folders = new Set(roots);
      for (let grew = true; grew; ) {
        grew = false;
        for (const x of ctx.folders.list()) if (x.parentId && folders.has(x.parentId) && !folders.has(x.id)) (folders.add(x.id), (grew = true));
      }
    }
    const statuses = ctx.statuses.list();
    const statusOk = (task: Task) => {
      if (!f.status) return true;
      if (f.status.startsWith("category:")) return statuses.find((s) => s.id === task.status)?.category === f.status.slice(9);
      return task.status === f.status;
    };
    const processes = ctx.processes.list();
    const now = Date.now();
    const sessions = ctx.agents.sessions();
    return (task) => {
      if (folders && !folders.has(task.folderId)) return false;
      if (!statusOk(task)) return false;
      if (f.process) {
        const run = ctx.processes.run(task.id);
        const w = processes.find((x) => x.id === run?.process);
        if (!run || !(run.process === f.process || w?.label.toLowerCase() === f.process.toLowerCase() || run.process.endsWith(`.${f.process}`)))
          return false;
      }
      if (f.source) {
        const auto = task.meta.automation as { id: string; how: string } | undefined;
        if (f.source === "manual" ? !!auto : f.source === "schedule" ? !auto || auto.how === "webhook" : f.source === "webhook" ? auto?.how !== "webhook" : auto?.id !== f.source)
          return false;
      }
      if (f.state) {
        const run = ctx.processes.run(task.id);
        const mine = sessions.filter((s) => s.taskId === task.id);
        const ok =
          f.state === "waiting"
            ? run?.state === "waiting"
            : f.state === "failed"
              ? run?.state === "failed"
              : f.state === "asking"
                ? mine.some((s) => s.asking)
                : mine.some((s) => s.state === "running" && s.busy) || run?.state === "running";
        if (!ok) return false;
      }
      if (f.created && task.createdAt < now - f.created * DAY) return false;
      if (f.updated && task.updatedAt < now - f.updated * DAY) return false;
      return true;
    };
  }
}
