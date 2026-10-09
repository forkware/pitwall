// "Workflow" became "process" (#42). Data written before that is renamed once: the database (by a migration),
// the settings file and the plugins' files. The old words live only here.
import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "./db.ts";

const OLD = "work" + "flow";
const ids: [string, string][] = [
  [`${OLD}-editor`, "process-editor"],
  [`my-${OLD}s`, "my-processes"],
];
const keys: Record<string, string> = {
  [OLD]: "process",
  [`${OLD}s`]: "processes",
  [`task${OLD[0].toUpperCase()}${OLD.slice(1)}s`]: "taskProcesses",
};

/** A plugin id, or a "<plugin>.<rest>" id or setting key, under its new name. */
export function renameId(value: string): string {
  for (const [from, to] of ids) {
    if (value === from) return to;
    if (value.startsWith(`${from}.`)) return to + value.slice(from.length);
  }
  return value;
}

/** Any text that holds ids: a kv key like "habit:<process id>|node|question". */
const renameText = (text: string) => ids.reduce((t, [from, to]) => t.replace(new RegExp(`(^|[^a-z0-9-])${from}(?=[./|:"]|$)`, "g"), `$1${to}`), text);

/** JSON data under the new names: object keys and ids, deep. */
export function renamed(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(renamed);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [keys[k] ?? renameId(k), renamed(v)]));
  }
  return typeof value === "string" ? renameId(value) : value;
}

const renamedJson = (text: string | null) => {
  if (text === null) return null;
  try {
    return JSON.stringify(renamed(JSON.parse(text)));
  } catch {
    return text;
  }
};

/** The database migration: tables, columns, plugin ids and the JSON that holds them. */
export function renameInDb(db: Db): void {
  db.exec(`
    ALTER TABLE ${OLD}_runs RENAME TO process_runs;
    ALTER TABLE process_runs RENAME COLUMN ${OLD} TO process;
    ALTER TABLE ${OLD}_versions RENAME TO process_versions;
    ALTER TABLE process_versions RENAME COLUMN ${OLD} TO process;
    DROP INDEX ${OLD}_trace_by_task;
    ALTER TABLE ${OLD}_trace RENAME TO process_trace;
    CREATE INDEX process_trace_by_task ON process_trace (task_id, seq);
  `);
  const each = (sql: string, fn: (row: Record<string, any>) => unknown[] | null, update: string) => {
    const set = db.prepare(update);
    for (const row of db.prepare(sql).all() as Record<string, any>[]) {
      const values = fn(row);
      if (values) set.run(...(values as any[]));
    }
  };
  each("SELECT task_id, process, options, waiting FROM process_runs", (r) => [renameId(r.process), renamedJson(r.options), renamedJson(r.waiting), r.task_id], "UPDATE process_runs SET process = ?, options = ?, waiting = ? WHERE task_id = ?");
  each(
    "SELECT rowid, process, plugin, spec FROM process_versions",
    (r) => [renameId(r.process), renameId(r.plugin), renamedJson(r.spec), r.rowid],
    "UPDATE OR REPLACE process_versions SET process = ?, plugin = ?, spec = ? WHERE rowid = ?",
  );
  each("SELECT seq, step FROM process_trace", (r) => [renameId(r.step), r.seq], "UPDATE process_trace SET step = ? WHERE seq = ?");
  each("SELECT id, settings, meta FROM folders", (r) => [renamedJson(r.settings), renamedJson(r.meta), r.id], "UPDATE folders SET settings = ?, meta = ? WHERE id = ?");
  each("SELECT id, meta, archived_by FROM tasks", (r) => [renamedJson(r.meta), r.archived_by && renameId(r.archived_by), r.id], "UPDATE tasks SET meta = ?, archived_by = ? WHERE id = ?");
  each("SELECT id, config FROM automations", (r) => [renamedJson(r.config), r.id], "UPDATE automations SET config = ? WHERE id = ?");
  each(
    "SELECT rowid, plugin, key, value FROM plugin_kv",
    (r) => [renameId(r.plugin), renameText(r.key), renamedJson(r.value), r.rowid],
    "UPDATE OR REPLACE plugin_kv SET plugin = ?, key = ?, value = ? WHERE rowid = ?",
  );
  each(
    "SELECT rowid, plugin, permission FROM audit",
    (r) => [renameId(r.plugin), String(r.permission).replace(`${OLD}s:`, "processes:"), r.rowid],
    "UPDATE audit SET plugin = ?, permission = ? WHERE rowid = ?",
  );
}

/** The settings file: its keys and values under the new names. */
export function renameSettingsFile(file: string): void {
  if (!existsSync(file)) return;
  const text = readFileSync(file, "utf8");
  if (!text.includes(OLD) && !text.includes(OLD[0].toUpperCase() + OLD.slice(1))) return;
  try {
    writeFileSync(file, JSON.stringify(renamed(JSON.parse(text)), null, 2) + "\n");
  } catch {
    // Not JSON: the settings read it as they can.
  }
}

/** The plugins' files: plugins/<id>/<old>s/ becomes processes/, the user's own plugin its new id, ids in the specs. */
export function renamePluginFiles(pluginsDir: string): void {
  if (!existsSync(pluginsDir)) return;
  for (const [from, to] of ids) {
    if (existsSync(join(pluginsDir, from)) && !existsSync(join(pluginsDir, to))) renameSync(join(pluginsDir, from), join(pluginsDir, to));
  }
  for (const plugin of readdirSync(pluginsDir)) {
    const dir = join(pluginsDir, plugin);
    if (!statSync(dir).isDirectory()) continue;
    const old = join(dir, `${OLD}s`);
    const now = join(dir, "processes");
    if (existsSync(old) && !existsSync(now)) renameSync(old, now);
    if (!existsSync(now)) continue;
    for (const name of readdirSync(now).filter((f) => f.endsWith(".json"))) {
      const file = join(now, name);
      const text = readFileSync(file, "utf8");
      if (!text.includes(OLD)) continue;
      try {
        writeFileSync(file, JSON.stringify(renamed(JSON.parse(text)), null, 2) + "\n");
      } catch {
        // A broken file stays as it is; loading it says why.
      }
    }
  }
}
