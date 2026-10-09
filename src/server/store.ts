// Folders, tasks and the status model.
import { randomUUID } from "node:crypto";
import type { Db } from "./db.ts";
import type { EventBus } from "./events.ts";
import type { Deletion, Folder, Meta, StatusDef, Task } from "../sdk/types.ts";
import type { TransitionGuard } from "../sdk/server.ts";

/** An error the user should see as is: bad input, a refused transition. */
export class UserError extends Error {}

const coreStatuses: StatusDef[] = [
  { id: "todo", label: "To do", color: "gray", category: "open", plugin: "core" },
  { id: "in_progress", label: "In progress", color: "blue", category: "active", plugin: "core" },
  { id: "done", label: "Done", color: "green", category: "done", plugin: "core" },
];

type Row = Record<string, any>;

const toFolder = (r: Row): Folder => ({
  id: r.id,
  parentId: r.parent_id,
  name: r.name,
  position: r.position,
  meta: JSON.parse(r.meta),
  settings: JSON.parse(r.settings),
  createdAt: r.created_at,
});

const toTask = (r: Row): Task => ({
  id: r.id,
  folderId: r.folder_id,
  title: r.title,
  body: r.body,
  status: r.status,
  position: r.position,
  meta: JSON.parse(r.meta),
  workspace: r.workspace ?? null,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  archivedAt: r.archived_at ?? null,
  archivedBy: r.archived_by ?? null,
  keep: !!r.keep,
  doneAt: r.done_at ?? null,
});

/** Which tasks a query returns: those in the tree (the default), the archived ones, or both. */
export type ArchiveFilter = "active" | "archived" | "all";

const archiveWhere: Record<ArchiveFilter, string> = {
  active: "archived_at IS NULL",
  archived: "archived_at IS NOT NULL",
  all: "1",
};



const mergeMeta = (meta: Meta, patch?: Meta): Meta => (patch ? { ...meta, ...patch } : meta);

/** Per key; null removes the key, so the folder inherits it again. */
function mergeSettings(settings: Record<string, unknown>, patch?: Record<string, unknown>): Record<string, unknown> {
  if (!patch) return settings;
  const next = { ...settings };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
}

export class Store {
  private statusDefs = new Map(coreStatuses.map((s) => [s.id, s]));
  private guards = new Set<TransitionGuard>();
  private db: Db;
  private events: EventBus;

  constructor(db: Db, events: EventBus) {
    this.db = db;
    this.events = events;
  }

  // Statuses

  statuses(): StatusDef[] {
    return [...this.statusDefs.values()];
  }

  registerStatuses(plugin: string, defs: Omit<StatusDef, "plugin">[]): void {
    for (const def of defs) this.statusDefs.set(def.id, { ...def, plugin });
    this.events.emit("status.registered", { plugin, ids: defs.map((d) => d.id) });
  }

  guardTransition(guard: TransitionGuard): () => void {
    this.guards.add(guard);
    return () => this.guards.delete(guard);
  }

  // Folders

  /** The folders in the tree; a deleted folder is gone from here, though its archived tasks keep it. */
  folders(): Folder[] {
    return this.db.prepare("SELECT * FROM folders WHERE deleted_at IS NULL ORDER BY position").all().map(toFolder);
  }

  folder(id: string, options: { deleted?: boolean } = {}): Folder | undefined {
    const row = this.db
      .prepare(`SELECT * FROM folders WHERE id = ?${options.deleted ? "" : " AND deleted_at IS NULL"}`)
      .get(id);
    return row ? toFolder(row) : undefined;
  }

  /** Whether the folder was deleted while archived tasks still need it. */
  folderDeleted(id: string): boolean {
    const row = this.db.prepare("SELECT deleted_at FROM folders WHERE id = ?").get(id) as { deleted_at: number | null } | undefined;
    return !!row?.deleted_at;
  }

  /** The folder and its ancestors, nearest first; deleted ones too, for the archived tasks in them. */
  chain(id: string): Folder[] {
    const chain: Folder[] = [];
    const get = (fid: string) => this.folder(fid, { deleted: true });
    for (let f = get(id); f; f = f.parentId ? get(f.parentId) : undefined) chain.push(f);
    return chain;
  }

  /** "Work / Client": the folder's path from the top. */
  path(id: string): string {
    return this.chain(id)
      .reverse()
      .map((f) => f.name)
      .join(" / ");
  }

  createFolder(input: { name: string; parentId?: string | null; meta?: Meta }): Folder {
    const parentId = input.parentId ?? null;
    if (parentId && !this.folder(parentId)) throw new UserError(`No folder ${parentId}`);
    const name = requireName(input.name);
    const { last } = this.db
      .prepare("SELECT max(position) AS last FROM folders WHERE parent_id IS ?")
      .get(parentId) as { last: number | null };
    const folder: Folder = {
      id: randomUUID(),
      parentId,
      name,
      position: (last ?? 0) + 1,
      meta: input.meta ?? {},
      settings: {},
      createdAt: Date.now(),
    };
    this.db
      .prepare("INSERT INTO folders (id, parent_id, name, position, meta, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(folder.id, parentId, name, folder.position, JSON.stringify(folder.meta), folder.createdAt);
    this.events.emit("folder.created", folder);
    return folder;
  }

  /** `settings` is merged per key, null removing one; the core's Settings checks the values first. */
  updateFolder(
    id: string,
    patch: { name?: string; parentId?: string | null; meta?: Meta; settings?: Record<string, unknown> },
  ): Folder {
    const folder = this.folder(id);
    if (!folder) throw new UserError(`No folder ${id}`);
    if (patch.parentId !== undefined && patch.parentId !== null) {
      if (this.chain(patch.parentId).some((f) => f.id === id)) throw new UserError("A folder cannot move into itself");
    }
    const next: Folder = {
      ...folder,
      name: patch.name !== undefined ? requireName(patch.name) : folder.name,
      parentId: patch.parentId !== undefined ? patch.parentId : folder.parentId,
      meta: mergeMeta(folder.meta, patch.meta),
      settings: mergeSettings(folder.settings, patch.settings),
    };
    this.db
      .prepare("UPDATE folders SET name = ?, parent_id = ?, meta = ?, settings = ? WHERE id = ?")
      .run(next.name, next.parentId, JSON.stringify(next.meta), JSON.stringify(next.settings), id);
    this.events.emit("folder.updated", next);
    return next;
  }

  /**
   * Deletes the folder with its subfolders. Their tasks go to the archive, and the folders stay hidden while
   * archived tasks need them: restoring one brings its folder back. A folder without tasks goes at once.
   */
  deleteFolder(id: string): void {
    const folder = this.folder(id);
    if (!folder) return;
    const ids = this.subtree(id);
    const tasks = ids.flatMap((fid) => this.tasks(fid, "all"));
    if (tasks.length === 0) {
      this.db.prepare("DELETE FROM folders WHERE id = ?").run(id);
    } else {
      const now = Date.now();
      for (const task of tasks) if (!task.archivedAt) this.archiveTask(task.id, "folder");
      for (const fid of ids) this.db.prepare("UPDATE folders SET deleted_at = ? WHERE id = ?").run(now, fid);
    }
    this.events.emit("folder.deleted", { ...folder, subtree: ids });
  }

  /** The folder's id and those of all its subfolders, deleted ones too. */
  subtree(id: string): string[] {
    const children = this.db.prepare("SELECT id FROM folders WHERE parent_id = ?").all(id) as { id: string }[];
    return [id, ...children.flatMap((c) => this.subtree(c.id))];
  }

  /** Deleted folders that no archived task needs any more go for good. */
  private purgeFolders(): void {
    for (;;) {
      const gone = this.db
        .prepare(
          `DELETE FROM folders WHERE deleted_at IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM tasks WHERE folder_id = folders.id)
             AND NOT EXISTS (SELECT 1 FROM folders AS c WHERE c.parent_id = folders.id)`,
        )
        .run();
      if (!gone.changes) return;
    }
  }

  // Tasks

  /** The tasks in the tree, of one folder or all; `archive` asks for the archived ones instead, or both. */
  tasks(folderId?: string, archive: ArchiveFilter = "active"): Task[] {
    const where = archiveWhere[archive];
    const rows = folderId
      ? this.db.prepare(`SELECT * FROM tasks WHERE folder_id = ? AND ${where} ORDER BY position`).all(folderId)
      : this.db.prepare(`SELECT * FROM tasks WHERE ${where} ORDER BY position`).all();
    return rows.map(toTask);
  }

  archivedCount(): number {
    return (this.db.prepare("SELECT count(*) AS n FROM tasks WHERE archived_at IS NOT NULL").get() as { n: number }).n;
  }

  /** Until when no rule archives or deletes the task: a grace period the user gave when turning a rule on. */
  holdUntil(id: string): number | null {
    const row = this.db.prepare("SELECT hold_until FROM tasks WHERE id = ?").get(id) as { hold_until: number | null } | undefined;
    return row?.hold_until ?? null;
  }

  hold(ids: string[], until: number): void {
    const update = this.db.prepare("UPDATE tasks SET hold_until = ? WHERE id = ?");
    for (const id of ids) update.run(until, id);
    if (ids.length) this.events.emit("archive.changed", { ids });
  }

  task(id: string): Task | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
    return row ? toTask(row) : undefined;
  }

  createTask(input: { folderId: string; title: string; body?: string; status?: string; meta?: Meta }): Task {
    if (!this.folder(input.folderId)) throw new UserError(`No folder ${input.folderId}`);
    const status = input.status ?? "todo";
    if (!this.statusDefs.has(status)) throw new UserError(`Unknown status ${status}`);
    const done = this.statusDefs.get(status)!.category === "done";
    const { last } = this.db
      .prepare("SELECT max(position) AS last FROM tasks WHERE folder_id = ?")
      .get(input.folderId) as { last: number | null };
    const now = Date.now();
    const task: Task = {
      id: randomUUID(),
      folderId: input.folderId,
      title: requireName(input.title),
      body: input.body ?? "",
      status,
      position: (last ?? 0) + 1,
      meta: input.meta ?? {},
      workspace: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      archivedBy: null,
      keep: false,
      doneAt: done ? now : null,
    };
    this.db
      .prepare(
        "INSERT INTO tasks (id, folder_id, title, body, status, position, meta, created_at, updated_at, done_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(task.id, task.folderId, task.title, task.body, status, task.position, JSON.stringify(task.meta), now, now, task.doneAt);
    this.events.emit("task.created", task);
    return task;
  }

  updateTask(
    id: string,
    patch: { title?: string; body?: string; folderId?: string; meta?: Meta; workspace?: string | null },
  ): Task {
    const task = this.task(id);
    if (!task) throw new UserError(`No task ${id}`);
    if (patch.folderId && !this.folder(patch.folderId)) throw new UserError(`No folder ${patch.folderId}`);
    const next: Task = {
      ...task,
      title: patch.title !== undefined ? requireName(patch.title) : task.title,
      body: patch.body ?? task.body,
      folderId: patch.folderId ?? task.folderId,
      meta: mergeMeta(task.meta, patch.meta),
      workspace: patch.workspace !== undefined ? patch.workspace : task.workspace,
      updatedAt: Date.now(),
    };
    this.saveTask(next);
    this.events.emit("task.updated", next);
    return next;
  }

  /** `guards: false` is for the core's processes, which own the status of their tasks. */
  setStatus(id: string, status: string, options: { guards?: boolean } = {}): Task {
    const task = this.task(id);
    if (!task) throw new UserError(`No task ${id}`);
    if (!this.statusDefs.has(status)) throw new UserError(`Unknown status ${status}`);
    if (task.status === status) return task;
    for (const guard of options.guards === false ? [] : this.guards) {
      const verdict = guard(task, task.status, status);
      if (verdict !== true) throw new UserError(verdict);
    }
    const now = Date.now();
    const done = this.statusDefs.get(status)!.category === "done";
    const wasDone = this.statusDefs.get(task.status)?.category === "done";
    const doneAt = done ? (wasDone && task.doneAt ? task.doneAt : now) : null;
    const next: Task = { ...task, status, updatedAt: now, doneAt };
    this.saveTask(next);
    this.events.emit("task.updated", next);
    this.events.emit("task.status.changed", { task: next, from: task.status, to: status });
    return next;
  }

  /**
   * Deletes the task for good, with its sessions. `rule`: a rule deleted it from the archive, and the archive's
   * log keeps its name.
   */
  deleteTask(id: string, options: { rule?: string } = {}): void {
    const task = this.task(id);
    if (!task) return;
    this.events.emit("task.deleting", task);
    if (options.rule) {
      this.db
        .prepare("INSERT INTO deletions (at, task_id, title, folder, rule) VALUES (?, ?, ?, ?, ?)")
        .run(Date.now(), task.id, task.title, this.path(task.folderId), options.rule);
    }
    this.db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
    this.purgeFolders();
    this.events.emit("task.deleted", task);
  }

  /** Tasks rules deleted from the archive since a time, newest first. */
  deletions(since = 0): Deletion[] {
    return (this.db.prepare("SELECT * FROM deletions WHERE at >= ? ORDER BY at DESC").all(since) as Row[]).map((r) => ({
      at: r.at,
      taskId: r.task_id,
      title: r.title,
      folder: r.folder,
      rule: r.rule,
    }));
  }

  // The archive

  /**
   * Takes the task out of the tree. It keeps its status, sessions and process; `by` says who archived it.
   * Listeners of task.archived stop what runs for it.
   */
  archiveTask(id: string, by = "user"): Task {
    const task = this.task(id);
    if (!task) throw new UserError(`No task ${id}`);
    if (task.archivedAt) return task;
    const next: Task = { ...task, archivedAt: Date.now(), archivedBy: by };
    this.db
      .prepare("UPDATE tasks SET archived_at = ?, archived_by = ?, hold_until = NULL WHERE id = ?")
      .run(next.archivedAt, by, id);
    this.events.emit("task.archived", next);
    return next;
  }

  /**
   * Brings the task back to the tree, where it was, with its status. A deleted folder it was in comes back too,
   * with its settings. A done task counts as done from now, so auto-archiving does not take it straight back.
   */
  restoreTask(id: string): Task {
    const task = this.task(id);
    if (!task) throw new UserError(`No task ${id}`);
    if (!task.archivedAt) return task;
    for (const folder of this.chain(task.folderId)) {
      if (!this.folderDeleted(folder.id)) continue;
      this.db.prepare("UPDATE folders SET deleted_at = NULL WHERE id = ?").run(folder.id);
      this.events.emit("folder.restored", this.folder(folder.id));
    }
    const next: Task = { ...task, archivedAt: null, archivedBy: null, doneAt: task.doneAt ? Date.now() : null };
    this.db
      .prepare("UPDATE tasks SET archived_at = NULL, archived_by = NULL, hold_until = NULL, done_at = ? WHERE id = ?")
      .run(next.doneAt, id);
    this.events.emit("task.restored", next);
    return next;
  }

  /** Whether rules may delete the archived task; a kept one stays until the user deletes it. */
  setKeep(id: string, keep: boolean): Task {
    const task = this.task(id);
    if (!task) throw new UserError(`No task ${id}`);
    this.db.prepare("UPDATE tasks SET keep = ? WHERE id = ?").run(keep ? 1 : 0, id);
    const next = { ...task, keep };
    this.events.emit("task.updated", next);
    return next;
  }

  private saveTask(t: Task): void {
    this.db
      .prepare(
        "UPDATE tasks SET folder_id = ?, title = ?, body = ?, status = ?, meta = ?, workspace = ?, updated_at = ?, done_at = ? WHERE id = ?",
      )
      .run(t.folderId, t.title, t.body, t.status, JSON.stringify(t.meta), t.workspace, t.updatedAt, t.doneAt, t.id);
  }
}

function requireName(name: unknown): string {
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (!trimmed) throw new UserError("Name cannot be empty");
  return trimmed;
}
