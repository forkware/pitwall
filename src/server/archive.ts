// The archive's rules: done tasks go to the archive after some days, archived ones are deleted after some more.
// Both are off until the user turns them on, per app or per folder; an automation can set its own.
import type { EventBus } from "./events.ts";
import type { Settings } from "./settings.ts";
import { UserError, type Store } from "./store.ts";
import type { ArchiveInfo, ArchivedTask, Task } from "../sdk/types.ts";

export const DAY = 24 * 60 * 60 * 1000;

/** How often the rules run; they also run soon after the start. */
const SWEEP_MS = 10 * 60 * 1000;

/** The settings, both `folder: true`: "off", or a number of days ("0" archives at once). */
export const ARCHIVE_AFTER = "archiveAfter";
export const DELETE_AFTER = "archiveDeleteAfter";

export const archiveAfterOptions = ["off", "0", "1", "3", "7", "14", "30"];
export const deleteAfterOptions = ["off", "7", "14", "30", "90", "180", "365"];

/** A setting's value as days, or null when the rule is off. */
export function days(value: unknown): number | null {
  if (value === null || value === undefined || value === "off" || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** What an automation says about its own tasks, instead of the folder's settings. */
export interface ArchivePolicy {
  /** Days after done before the task goes to the archive; null: never. */
  archiveAfter?: number | null;
  /** Days in the archive before it is deleted; null: never. */
  deleteAfter?: number | null;
}

export type PolicySource = (task: Task) => ArchivePolicy | undefined;

export class Archive {
  private sources: PolicySource[] = [];
  private extra: (() => number)[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private store: Store;
  private settings: Settings;
  private events: EventBus;

  constructor(store: Store, settings: Settings, events: EventBus) {
    this.store = store;
    this.settings = settings;
    this.events = events;
  }

  /** Lets an automation decide for its tasks; the first source that answers for a key wins. */
  addPolicy(source: PolicySource): void {
    this.sources.push(source);
  }

  /** Another rule that deletes from the archive, run with these; returns how many it deleted. */
  onSweep(rule: () => number): void {
    this.extra.push(rule);
  }

  /** Runs the rules now and then every few minutes, until stop(). */
  start(): void {
    const tick = () => {
      try {
        this.sweep();
      } catch (error) {
        console.error("The archive's rules failed:", error);
      }
      this.timer = setTimeout(tick, SWEEP_MS);
      this.timer.unref?.();
    };
    this.timer = setTimeout(tick, 5000);
    this.timer.unref?.();
  }

  stop(): void {
    clearTimeout(this.timer);
  }

  /** The task's rules: its automation's, else its folder's settings. */
  policy(task: Task, override?: { key: string; value: unknown; folderId: string | null }): Required<ArchivePolicy> {
    const own: ArchivePolicy = {};
    for (const source of this.sources) {
      const p = source(task);
      if (!p) continue;
      if (own.archiveAfter === undefined && p.archiveAfter !== undefined) own.archiveAfter = p.archiveAfter;
      if (own.deleteAfter === undefined && p.deleteAfter !== undefined) own.deleteAfter = p.deleteAfter;
    }
    const setting = (key: string) => days(override?.key === key ? this.valueWith(task, override) : this.settings.get(key, task.folderId));
    return {
      archiveAfter: own.archiveAfter !== undefined ? own.archiveAfter : setting(ARCHIVE_AFTER),
      deleteAfter: own.deleteAfter !== undefined ? own.deleteAfter : setting(DELETE_AFTER),
    };
  }

  /** The setting's value for the task if `override.folderId` (null: the app) had `override.value`. */
  private valueWith(task: Task, override: { key: string; value: unknown; folderId: string | null }): unknown {
    for (const folder of this.store.chain(task.folderId)) {
      if (folder.id === override.folderId) return override.value;
      if (override.key in folder.settings) return folder.settings[override.key];
    }
    return override.folderId === null ? override.value : this.settings.get(override.key, task.folderId);
  }

  /** When a rule archives the task: null when none will, or the task is not done. */
  archiveAt(task: Task, policy = this.policy(task)): number | null {
    if (task.archivedAt || !task.doneAt || policy.archiveAfter === null) return null;
    return Math.max(task.doneAt + policy.archiveAfter * DAY, this.store.holdUntil(task.id) ?? 0);
  }

  /** When a rule deletes the archived task: null when none will, or the user kept it. */
  deleteAt(task: Task, policy = this.policy(task)): number | null {
    if (!task.archivedAt || task.keep || policy.deleteAfter === null) return null;
    return Math.max(task.archivedAt + policy.deleteAfter * DAY, this.store.holdUntil(task.id) ?? 0);
  }

  /** Archives and deletes what is due. Tells the UI how many, when any. */
  sweep(now = Date.now()): { archived: number; deleted: number } {
    let archived = 0;
    let deleted = 0;
    for (const task of this.store.tasks(undefined, "active")) {
      const at = this.archiveAt(task);
      if (at === null || at > now) continue;
      this.store.archiveTask(task.id, task.meta.automation ? `automation:${(task.meta.automation as { id: string }).id}` : "rule");
      archived++;
    }
    for (const task of this.store.tasks(undefined, "archived")) {
      const at = this.deleteAt(task);
      if (at === null || at > now) continue;
      this.store.deleteTask(task.id, { rule: task.meta.automation ? "automation" : "days" });
      deleted++;
    }
    for (const rule of this.extra) deleted += rule();
    if (archived || deleted) this.events.emit("archive.swept", { archived, deleted });
    return { archived, deleted };
  }

  /** The archived tasks, with their folder's path and when a rule deletes them. */
  list(folderId?: string | null): ArchivedTask[] {
    const folders = folderId ? new Set(this.store.subtree(folderId)) : null;
    return this.store
      .tasks(undefined, "archived")
      .filter((t) => !folders || folders.has(t.folderId))
      .sort((a, b) => b.archivedAt! - a.archivedAt!)
      .map((task) => this.describe(task));
  }

  /** A task with its folder's path and when a rule deletes it. */
  describe(task: Task): ArchivedTask {
    return {
      ...task,
      folderPath: this.store.path(task.folderId),
      folderDeleted: this.store.folderDeleted(task.folderId),
      deleteAt: this.deleteAt(task),
    };
  }

  /** What the tree and the sidebar show of the archive. */
  info(now = Date.now()): ArchiveInfo {
    const week = now + 7 * DAY;
    let dueSoon = 0;
    for (const task of this.store.tasks(undefined, "archived")) {
      const at = this.deleteAt(task);
      if (at !== null && at <= week) dueSoon++;
    }
    const archiveAt: Record<string, number> = {};
    for (const task of this.store.tasks(undefined, "active")) {
      const at = this.archiveAt(task);
      if (at !== null) archiveAt[task.id] = at;
    }
    return { count: this.store.archivedCount(), dueSoon, archiveAt };
  }

  /**
   * The tasks a rule would take at once if the setting `key` of a folder (null: the app) became `value`:
   * shown before the user turns a rule on.
   */
  preview(key: string, value: unknown, folderId: string | null, now = Date.now()): Task[] {
    if (key !== ARCHIVE_AFTER && key !== DELETE_AFTER) throw new UserError(`${key} is not a rule of the archive`);
    const folders = folderId ? new Set(this.store.subtree(folderId)) : null;
    const archive = key === ARCHIVE_AFTER;
    return this.store.tasks(undefined, archive ? "active" : "archived").filter((task) => {
      if (folders && !folders.has(task.folderId)) return false;
      const policy = this.policy(task, { key, value, folderId });
      const before = archive ? this.archiveAt(task) : this.deleteAt(task);
      const after = archive ? this.archiveAt(task, policy) : this.deleteAt(task, policy);
      return after !== null && after <= now && (before === null || before > now);
    });
  }

  /** Gives the tasks the preview found `graceDays` more before a rule takes them. */
  hold(key: string, value: unknown, folderId: string | null, graceDays: number): number {
    const tasks = this.preview(key, value, folderId);
    this.store.hold(
      tasks.map((t) => t.id),
      Date.now() + graceDays * DAY,
    );
    return tasks.length;
  }
}
