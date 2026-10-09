import { DatabaseSync } from "node:sqlite";
import { renameInDb } from "./renameProcess.ts";

// Each entry upgrades the schema by one version; never edit one that has shipped (so the old ones keep their old words).
export const migrations: (string | ((db: DatabaseSync) => void))[] = [
  `
  CREATE TABLE folders (
    id TEXT PRIMARY KEY,
    parent_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    position REAL NOT NULL,
    meta TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    position REAL NOT NULL,
    meta TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    cwd TEXT NOT NULL,
    state TEXT NOT NULL,
    exit_code INTEGER,
    started_at INTEGER NOT NULL,
    ended_at INTEGER
  );
  CREATE TABLE plugin_kv (
    plugin TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (plugin, key)
  );
  CREATE TABLE audit (
    at INTEGER NOT NULL,
    plugin TEXT NOT NULL,
    action TEXT NOT NULL,
    permission TEXT NOT NULL,
    declared INTEGER NOT NULL
  );
  `,
  `ALTER TABLE folders ADD COLUMN settings TEXT NOT NULL DEFAULT '{}';`,
  `
  CREATE TABLE checkpoints (
    thread_id TEXT NOT NULL,
    ns TEXT NOT NULL,
    id TEXT NOT NULL,
    parent_id TEXT,
    type TEXT NOT NULL,
    checkpoint BLOB NOT NULL,
    metadata_type TEXT NOT NULL,
    metadata BLOB NOT NULL,
    PRIMARY KEY (thread_id, ns, id)
  );
  CREATE TABLE checkpoint_writes (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL,
    ns TEXT NOT NULL,
    checkpoint_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    idx INTEGER NOT NULL,
    channel TEXT NOT NULL,
    type TEXT NOT NULL,
    value BLOB NOT NULL,
    UNIQUE (thread_id, ns, checkpoint_id, task_id, idx)
  );
  CREATE TABLE workflow_runs (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
    workflow TEXT NOT NULL,
    state TEXT NOT NULL,
    node TEXT,
    waiting TEXT,
    error TEXT,
    started_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  // Sessions the app's stop cut off (no exit code) can be resumed now.
  `
  ALTER TABLE sessions ADD COLUMN agent_session_id TEXT;
  UPDATE sessions SET state = 'suspended' WHERE state = 'exited' AND exit_code IS NULL;
  `,
  `ALTER TABLE workflow_runs ADD COLUMN progress TEXT;`,
  `ALTER TABLE tasks ADD COLUMN workspace TEXT;`,
  // Why a session ended, when the app or a plugin ended it: "stopped", "gone", a plugin's own.
  `ALTER TABLE sessions ADD COLUMN exit_reason TEXT;`,
  // The archive: a task leaves the tree before it is deleted; a deleted folder stays while its archived tasks need it.
  `
  ALTER TABLE tasks ADD COLUMN archived_at INTEGER;
  ALTER TABLE tasks ADD COLUMN archived_by TEXT;
  ALTER TABLE tasks ADD COLUMN keep INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE tasks ADD COLUMN done_at INTEGER;
  ALTER TABLE tasks ADD COLUMN hold_until INTEGER;
  UPDATE tasks SET done_at = updated_at WHERE status = 'done';
  ALTER TABLE folders ADD COLUMN deleted_at INTEGER;
  CREATE TABLE deletions (
    at INTEGER NOT NULL,
    task_id TEXT NOT NULL,
    title TEXT NOT NULL,
    folder TEXT NOT NULL,
    rule TEXT NOT NULL
  );
  `,
  // Automations: tasks made by a schedule or a webhook, and the log of what each trigger did.
  `
  CREATE TABLE automations (
    id TEXT PRIMARY KEY,
    folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    config TEXT NOT NULL,
    secret TEXT NOT NULL,
    cursor INTEGER,
    last_payload TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE automation_runs (
    id TEXT PRIMARY KEY,
    automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
    at INTEGER NOT NULL,
    how TEXT NOT NULL,
    task_id TEXT,
    result TEXT NOT NULL,
    detail TEXT,
    payload TEXT
  );
  CREATE INDEX automation_runs_by_automation ON automation_runs (automation_id, at);
  `,
  // Workflows as data: the versions of file workflows (a task keeps the one it started with), the steps each
  // task's workflow ran, and how a run goes (a trial, without consequences, step by step).
  `
  ALTER TABLE workflow_runs ADD COLUMN version TEXT;
  ALTER TABLE workflow_runs ADD COLUMN options TEXT;
  CREATE TABLE workflow_versions (
    workflow TEXT NOT NULL,
    version TEXT NOT NULL,
    plugin TEXT NOT NULL,
    spec TEXT NOT NULL,
    at INTEGER NOT NULL,
    note TEXT,
    PRIMARY KEY (workflow, version)
  );
  CREATE TABLE workflow_trace (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    node TEXT NOT NULL,
    step TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    result TEXT NOT NULL,
    output TEXT,
    answer TEXT,
    error TEXT
  );
  CREATE INDEX workflow_trace_by_task ON workflow_trace (task_id, seq);
  `,
  // "Workflow" became "process": its tables, columns and the ids and keys in the data.
  renameInDb,
];

export type Db = DatabaseSync;

export function openDb(file: string): Db {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  const { user_version: version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
  for (let v = version; v < migrations.length; v++) {
    db.exec("BEGIN");
    const step = migrations[v];
    if (typeof step === "string") db.exec(step);
    else step(db);
    db.exec(`PRAGMA user_version = ${v + 1}`);
    db.exec("COMMIT");
  }
  return db;
}
