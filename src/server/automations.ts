// Automations: a folder's tasks made by a schedule (cron) or by a request to a webhook. A task an automation makes
// follows its process like any other; the automation keeps a log of its runs and decides when its tasks are archived.
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Archive } from "./archive.ts";
import { checkTimezone, nextRun, nextRuns, parseCron, wallClock } from "./cron.ts";
import type { Db } from "./db.ts";
import type { EventBus } from "./events.ts";
import type { Sessions } from "./sessions.ts";
import { UserError, type Store } from "./store.ts";
import { caseOf, type Processes } from "./processes.ts";
import type {
  Automation,
  AutomationConfig,
  AutomationHow,
  AutomationRun,
  AutomationRunView,
  AutomationTrigger,
  Task,
} from "../sdk/types.ts";

/** How many runs each automation keeps in its log. */
const RUNS_KEPT = 200;
/** The schedule looks again at least this often, so a clock change or a long sleep does not lose a run. */
const MAX_WAIT = 60 * 60 * 1000;

type Row = Record<string, any>;

/** What `meta.automation` of a task an automation made holds. */
export interface AutomationMeta {
  id: string;
  runId: string;
  how: AutomationHow;
  /** The webhook's request body. */
  payload?: unknown;
}

export const automationOf = (task: Task): AutomationMeta | undefined =>
  task.meta.automation as AutomationMeta | undefined;

export const defaultConfig = (): AutomationConfig => ({
  trigger: { kind: "schedule", cron: "0 9 * * *", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, missed: "skip" },
  process: null,
  title: "{{automation}} · {{datetime}}",
  body: "",
  answers: {},
  questions: {},
  seen: [],
  startAgent: false,
  overlap: "skip",
  view: "group",
  archiveAfter: 0,
  deleteAfter: "folder",
  keepRuns: null,
});

/** What a webhook request gets back. */
export interface HookAnswer {
  status: number;
  body: Record<string, unknown>;
}

export class Automations {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private db: Db;
  private events: EventBus;
  private store: Store;
  private processes: Processes;
  private sessions: Sessions;

  constructor(db: Db, events: EventBus, store: Store, processes: Processes, sessions: Sessions, archive: Archive) {
    this.db = db;
    this.events = events;
    this.store = store;
    this.processes = processes;
    this.sessions = sessions;

    // Its tasks: archived when the automation says, deleted when it says, its last N kept.
    archive.addPolicy((task) => {
      const meta = automationOf(task);
      const a = meta && this.get(meta.id);
      if (!a) return undefined;
      return {
        archiveAfter: a.archiveAfter === "folder" ? undefined : a.archiveAfter,
        deleteAfter: a.deleteAfter === "folder" ? undefined : a.deleteAfter,
      };
    });
    events.on("task.status.changed", ({ task, to }: { task: Task; to: string }) => {
      const meta = automationOf(task);
      const a = meta && this.get(meta.id);
      const done = this.store.statuses().find((s) => s.id === to)?.category === "done";
      // "At once" does not wait for the archive's next sweep.
      if (a && done && a.archiveAfter === 0) {
        setImmediate(() => {
          const now = this.store.task(task.id);
          if (now && !now.archivedAt && now.doneAt) this.store.archiveTask(task.id, `automation:${a.id}`);
        });
      }
    });
    events.on("folder.deleted", ({ subtree }: { subtree?: string[] }) => {
      for (const folderId of subtree ?? []) {
        for (const a of this.list().filter((x) => x.folderId === folderId)) this.remove(a.id, "keep");
      }
    });
    archive.onSweep(() => this.sweep());
    // Its tasks' processes ask: what the automation says to answer for the user, when it says.
    processes.autoAnswer = (task, run, request) => {
      const meta = automationOf(task);
      const a = meta && this.get(meta.id);
      const rule = a?.questions[`${run.node}:${request.id ?? "main"}`];
      if (!rule || rule.answer === "wait" || request.kind === "form") return undefined;
      if (rule.when && caseOf(this.processes.lastValue(task.id, rule.when.key)) !== rule.when.value) return undefined;
      if (rule.answer === "stop") return "stop";
      return request.options.some((o) => o.id === rule.answer) ? rule.answer : undefined;
    };
  }

  // The list

  list(): Automation[] {
    return (this.db.prepare("SELECT * FROM automations ORDER BY created_at").all() as Row[]).map((r) => this.toAutomation(r));
  }

  get(id: string): Automation | undefined {
    const row = this.db.prepare("SELECT * FROM automations WHERE id = ?").get(id) as Row | undefined;
    return row ? this.toAutomation(row) : undefined;
  }

  private toAutomation(r: Row): Automation {
    const config = { ...defaultConfig(), ...JSON.parse(r.config) } as AutomationConfig;
    const lastRow = this.db
      .prepare("SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY at DESC LIMIT 3")
      .all(r.id) as Row[];
    const recent = lastRow.map(toRun);
    const lastRun = recent[0] ?? null;
    const lastTask = this.lastTask(r.id);
    const processFailed = !!lastTask && this.processes.run(lastTask.id)?.state === "failed";
    let next: number | null = null;
    if (r.enabled && config.trigger.kind === "schedule") {
      try {
        next = nextRun(parseCron(config.trigger.cron), Date.now(), config.trigger.timezone);
      } catch {}
    }
    return {
      ...config,
      id: r.id,
      folderId: r.folder_id,
      name: r.name,
      enabled: !!r.enabled,
      secret: r.secret,
      createdAt: r.created_at,
      nextRun: next,
      lastRun,
      failing: lastRun?.result === "error" || processFailed,
      rejecting: recent.length === 3 && recent.every((x) => x.result === "rejected" && x.detail === "signature"),
      hookPath: config.trigger.kind === "webhook" && config.trigger.verify === "url" ? `/hooks/${r.id}/${r.secret}` : `/hooks/${r.id}`,
      lastPayload: r.last_payload ? JSON.parse(r.last_payload) : null,
    };
  }

  /** The last task it made, archived or not; deleted ones are gone. */
  private lastTask(id: string): Task | undefined {
    return this.tasksOf(id).sort((a, b) => b.createdAt - a.createdAt)[0];
  }

  /** Its tasks, archived ones too. */
  tasksOf(id: string): Task[] {
    return this.store.tasks(undefined, "all").filter((t) => automationOf(t)?.id === id);
  }

  runs(id: string, limit = RUNS_KEPT): AutomationRunView[] {
    const rows = this.db
      .prepare("SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY at DESC LIMIT ?")
      .all(id, limit) as Row[];
    return rows.map(toRun).map((run) => {
      const task = run.taskId ? this.store.task(run.taskId) : undefined;
      return {
        ...run,
        task: task
          ? { title: task.title, status: task.status, archived: !!task.archivedAt, process: this.processes.run(task.id)?.state ?? null }
          : null,
      };
    });
  }

  // Changes

  create(input: { folderId: string; name: string; enabled?: boolean } & Partial<AutomationConfig>): Automation {
    if (!this.store.folder(input.folderId)) throw new UserError(`No folder ${input.folderId}`);
    const config = this.check({ ...defaultConfig(), ...pickConfig(input) });
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO automations (id, folder_id, name, enabled, config, secret, cursor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, input.folderId, requireName(input.name), input.enabled === false ? 0 : 1, JSON.stringify(config), newSecret(), Date.now(), Date.now());
    this.changed(id);
    return this.get(id)!;
  }

  update(id: string, patch: { name?: string; enabled?: boolean; folderId?: string } & Partial<AutomationConfig>): Automation {
    const a = this.get(id);
    if (!a) throw new UserError(`No automation ${id}`);
    if (patch.folderId && !this.store.folder(patch.folderId)) throw new UserError(`No folder ${patch.folderId}`);
    const config = this.check({ ...pickConfig(a), ...pickConfig(patch) } as AutomationConfig);
    const resumed = patch.enabled === true && !a.enabled;
    this.db
      .prepare("UPDATE automations SET name = ?, enabled = ?, folder_id = ?, config = ?, cursor = ? WHERE id = ?")
      .run(
        patch.name !== undefined ? requireName(patch.name) : a.name,
        patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : a.enabled ? 1 : 0,
        patch.folderId ?? a.folderId,
        JSON.stringify(config),
        // A schedule changed or resumed counts from now: what it would have done before does not happen.
        resumed || patch.trigger ? Date.now() : this.cursor(id),
        id,
      );
    this.changed(id);
    return this.get(id)!;
  }

  /** Deletes the automation and its log. Its tasks stay, or go to the archive. */
  remove(id: string, tasks: "keep" | "archive" = "keep"): void {
    const a = this.get(id);
    if (!a) return;
    if (tasks === "archive") {
      for (const task of this.tasksOf(id)) if (!task.archivedAt) this.store.archiveTask(task.id, `automation:${id}`);
    }
    this.db.prepare("DELETE FROM automations WHERE id = ?").run(id);
    this.events.emit("automation.deleted", { id });
    this.reschedule();
  }

  /** A new secret: the old webhook address or signature stops working. */
  newSecret(id: string): Automation {
    if (!this.get(id)) throw new UserError(`No automation ${id}`);
    this.db.prepare("UPDATE automations SET secret = ? WHERE id = ?").run(newSecret(), id);
    this.changed(id);
    return this.get(id)!;
  }

  private changed(id: string): void {
    this.events.emit("automation.updated", { id });
    this.reschedule();
  }

  /** Checks a config and gives it back cleaned. */
  check(config: AutomationConfig): AutomationConfig {
    const t = config.trigger as AutomationTrigger;
    if (t?.kind === "schedule") {
      try {
        parseCron(t.cron);
        checkTimezone(t.timezone);
      } catch (error) {
        throw new UserError((error as Error).message);
      }
      if (t.missed !== "skip" && t.missed !== "once") throw new UserError('missed: "skip" or "once"');
    } else if (t?.kind === "webhook") {
      if (!["url", "github", "header"].includes(t.verify)) throw new UserError('verify: "url", "github" or "header"');
      if (t.filter?.trim()) {
        try {
          parseFilter(t.filter);
        } catch (error) {
          throw new UserError(`Filter: ${(error as Error).message}`);
        }
      }
    } else throw new UserError('trigger: a "schedule" or a "webhook"');
    if (config.process !== null) {
      const w = this.processes.list().find((x) => x.id === config.process);
      if (!w) throw new UserError(`No process ${config.process}`);
      if (w.problems.length) throw new UserError(`${w.label} cannot run: ${w.problems.join("; ")}`);
    }
    if (typeof config.title !== "string" || !config.title.trim()) throw new UserError("The task's title cannot be empty");
    if (!["skip", "always"].includes(config.overlap)) throw new UserError('overlap: "skip" or "always"');
    if (!["group", "folder", "hidden"].includes(config.view)) throw new UserError('view: "group", "folder" or "hidden"');
    for (const key of ["archiveAfter", "deleteAfter"] as const) {
      const v = config[key];
      if (!(v === null || v === "folder" || (typeof v === "number" && v >= 0))) throw new UserError(`${key}: days, null or "folder"`);
    }
    if (!config.questions || typeof config.questions !== "object" || Array.isArray(config.questions)) throw new UserError("questions: an object");
    for (const [key, rule] of Object.entries(config.questions)) {
      if (!rule || typeof rule.answer !== "string" || !rule.answer) throw new UserError(`questions.${key}: an answer`);
      if (rule.when && (typeof rule.when.key !== "string" || typeof rule.when.value !== "string")) throw new UserError(`questions.${key}.when: { key, value }`);
    }
    if (!Array.isArray(config.seen) || config.seen.some((x) => typeof x !== "string")) throw new UserError("seen: a list of questions");
    if (!(config.keepRuns === null || (Number.isInteger(config.keepRuns) && config.keepRuns > 0))) {
      throw new UserError("keepRuns: a positive number or null");
    }
    return config;
  }

  // Runs

  /**
   * Makes the automation's task now, or says why not. `manual` makes it even while paused and while
   * the last task is not done.
   */
  async fire(id: string, how: AutomationHow, payload?: unknown): Promise<AutomationRun> {
    const a = this.get(id);
    if (!a) throw new UserError(`No automation ${id}`);
    const runId = randomUUID();
    const log = (result: AutomationRun["result"], detail: string | null, taskId: string | null = null) =>
      this.log({ id: runId, automationId: id, at: Date.now(), how, taskId, result, detail, payload: payload ?? null });

    if (!a.enabled && how !== "manual") return log("skipped", "paused");
    if (a.overlap === "skip" && how !== "manual") {
      const last = this.lastTask(id);
      const done = last && (last.archivedAt || last.doneAt);
      if (last && !done) return log("skipped", "previous", last.id);
    }

    const tz = a.trigger.kind === "schedule" ? a.trigger.timezone : Intl.DateTimeFormat().resolvedOptions().timeZone;
    const vars = templateVars(a, tz, payload);
    const missing = new Set<string>();
    const title = render(a.title, vars, missing).trim();
    const body = render(a.body, vars, missing).trim();
    if (!title) return log("error", `The title is empty${missing.size ? `: no ${[...missing].join(", ")}` : ""}`);

    const meta: AutomationMeta = { id, runId, how, ...(payload !== undefined ? { payload } : {}) };
    try {
      const input = { folderId: a.folderId, title: title.slice(0, 200), body, meta: { automation: meta } };
      const task = a.process ? this.processes.createTask(input, a.process) : this.store.createTask(input);
      const run = log("created", missing.size ? `No ${[...missing].join(", ")}` : null, task.id);
      if (a.process) void this.answerForm(task.id, a, vars, title, body);
      else if (a.startAgent) {
        try {
          this.sessions.start(task.id, { prompt: body ? `${title}\n\n${body}` : title });
        } catch (error) {
          this.setDetail(runId, (error as Error).message);
        }
      }
      return run;
    } catch (error) {
      return log("error", (error as Error).message);
    }
  }

  /**
   * The process's first step usually asks for the task in a form; the automation answers it with its own
   * answers, else a field named title or body with the task's, else a single field with the description.
   */
  private async answerForm(taskId: string, a: Automation, vars: Record<string, unknown>, title: string, body: string) {
    const run = await this.processes.settled(taskId);
    if (run?.state !== "waiting" || run.request?.kind !== "form") return;
    const fields = run.request.fields;
    const answer: Record<string, string> = {};
    for (const field of fields) {
      const own = a.answers[field.id];
      const value =
        own !== undefined
          ? render(own, vars, new Set())
          : field.id === "title"
            ? title
            : field.id === "body"
              ? body
              : fields.length === 1
                ? body || title
                : undefined;
      if (value !== undefined) answer[field.id] = value;
    }
    try {
      this.processes.resume(taskId, answer);
    } catch (error) {
      // A required field it has no answer for: the task waits for the user, like a task made by hand.
      this.events.emit("automation.updated", { id: a.id, note: (error as Error).message });
    }
  }

  private log(run: AutomationRun): AutomationRun {
    this.db
      .prepare("INSERT INTO automation_runs (id, automation_id, at, how, task_id, result, detail, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(run.id, run.automationId, run.at, run.how, run.taskId, run.result, run.detail, run.payload === null ? null : JSON.stringify(run.payload));
    this.db
      .prepare(
        `DELETE FROM automation_runs WHERE automation_id = ? AND id NOT IN
           (SELECT id FROM automation_runs WHERE automation_id = ? ORDER BY at DESC LIMIT ${RUNS_KEPT})`,
      )
      .run(run.automationId, run.automationId);
    this.events.emit("automation.run", { automationId: run.automationId, runId: run.id, taskId: run.taskId, result: run.result, detail: run.detail });
    this.events.emit("automation.updated", { id: run.automationId });
    return run;
  }

  private setDetail(runId: string, detail: string): void {
    this.db.prepare("UPDATE automation_runs SET detail = ? WHERE id = ?").run(detail, runId);
  }

  /** Keeps each automation's last N archived tasks, deleting older ones; run by the archive's sweep. */
  sweep(): number {
    let deleted = 0;
    for (const a of this.list()) {
      if (a.keepRuns === null) continue;
      const archived = this.tasksOf(a.id)
        .filter((t) => t.archivedAt && !t.keep)
        .sort((x, y) => y.createdAt - x.createdAt);
      for (const task of archived.slice(a.keepRuns)) {
        this.store.deleteTask(task.id, { rule: "runs" });
        deleted++;
      }
    }
    return deleted;
  }

  // The schedule

  /** Handles the runs missed while the app was off, then waits for the next ones. */
  start(): void {
    const now = Date.now();
    for (const a of this.list()) {
      if (!a.enabled || a.trigger.kind !== "schedule") continue;
      const cursor = this.cursor(a.id) ?? a.createdAt;
      const missed = safeNext(a.trigger.cron, cursor, a.trigger.timezone);
      if (missed !== null && missed <= now) {
        if (a.trigger.missed === "once") void this.fire(a.id, "missed");
        else this.log({ id: randomUUID(), automationId: a.id, at: now, how: "missed", taskId: null, result: "skipped", detail: "app-off", payload: null });
      }
      this.setCursor(a.id, now);
    }
    this.reschedule();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  private reschedule(): void {
    clearTimeout(this.timer);
    if (this.stopped) return;
    let wait = MAX_WAIT;
    const now = Date.now();
    for (const a of this.list()) {
      if (!a.enabled || a.trigger.kind !== "schedule") continue;
      const next = safeNext(a.trigger.cron, this.cursor(a.id) ?? now, a.trigger.timezone);
      if (next !== null) wait = Math.min(wait, Math.max(0, next - now));
    }
    this.timer = setTimeout(() => this.tick(), wait + 50);
    this.timer.unref?.();
  }

  /** Fires the schedules that are due. */
  tick(now = Date.now()): void {
    for (const a of this.list()) {
      if (!a.enabled || a.trigger.kind !== "schedule") continue;
      const next = safeNext(a.trigger.cron, this.cursor(a.id) ?? now, a.trigger.timezone);
      this.setCursor(a.id, now);
      if (next !== null && next <= now) void this.fire(a.id, "schedule");
    }
    this.reschedule();
  }

  private cursor(id: string): number | null {
    return (this.db.prepare("SELECT cursor FROM automations WHERE id = ?").get(id) as { cursor: number | null } | undefined)?.cursor ?? null;
  }

  private setCursor(id: string, at: number): void {
    this.db.prepare("UPDATE automations SET cursor = ? WHERE id = ?").run(at, id);
  }

  // Webhooks

  /** A request to `/hooks/<id>[/<secret>]`: checks it, logs it and makes the task. */
  async hook(id: string, pathSecret: string | undefined, headers: Record<string, string | string[] | undefined>, raw: string): Promise<HookAnswer> {
    const a = this.get(id);
    if (!a || a.trigger.kind !== "webhook") return { status: 404, body: { error: "No such webhook" } };
    const payload = parsePayload(raw);
    const reject = (detail: string, status: number, error: string): HookAnswer => {
      this.log({ id: randomUUID(), automationId: id, at: Date.now(), how: "webhook", taskId: null, result: "rejected", detail, payload });
      return { status, body: { error } };
    };
    if (!verify(a, pathSecret, headers, raw)) return reject("signature", 403, "The request does not prove itself");
    this.db.prepare("UPDATE automations SET last_payload = ? WHERE id = ?").run(JSON.stringify(payload), id);
    if (!a.enabled) {
      this.log({ id: randomUUID(), automationId: id, at: Date.now(), how: "webhook", taskId: null, result: "skipped", detail: "paused", payload });
      return { status: 503, body: { error: "The automation is paused" } };
    }
    if (a.trigger.filter?.trim()) {
      let pass = false;
      try {
        pass = parseFilter(a.trigger.filter)({ payload });
      } catch {}
      if (!pass) return reject("filter", 202, "Filtered out");
    }
    const run = await this.fire(id, "webhook", payload);
    return run.result === "created"
      ? { status: 200, body: { taskId: run.taskId } }
      : { status: run.result === "error" ? 500 : 202, body: { result: run.result, detail: run.detail } };
  }
}

// Helpers

const toRun = (r: Row): AutomationRun => ({
  id: r.id,
  automationId: r.automation_id,
  at: r.at,
  how: r.how,
  taskId: r.task_id ?? null,
  result: r.result,
  detail: r.detail ?? null,
  payload: r.payload ? JSON.parse(r.payload) : null,
});

const configKeys: (keyof AutomationConfig)[] = [
  "trigger",
  "process",
  "title",
  "body",
  "answers",
  "questions",
  "seen",
  "startAgent",
  "overlap",
  "view",
  "archiveAfter",
  "deleteAfter",
  "keepRuns",
];

function pickConfig(input: Partial<AutomationConfig>): Partial<AutomationConfig> {
  const out: Record<string, unknown> = {};
  for (const key of configKeys) if (input[key] !== undefined) out[key] = input[key];
  return out as Partial<AutomationConfig>;
}

function requireName(name: unknown): string {
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (!trimmed) throw new UserError("Name cannot be empty");
  return trimmed;
}

const newSecret = () => randomBytes(18).toString("base64url");

function safeNext(cron: string, after: number, timezone: string): number | null {
  try {
    return nextRun(parseCron(cron), after, timezone);
  } catch {
    return null;
  }
}

/** The next runs of an expression, or why it is wrong: for the dialog that edits a schedule. */
export function previewCron(cron: string, timezone: string, count = 3): { next: number[]; error: string | null } {
  try {
    checkTimezone(timezone);
    return { next: nextRuns(parseCron(cron), Date.now(), timezone, count), error: null };
  } catch (error) {
    return { next: [], error: (error as Error).message };
  }
}

const pad = (n: number) => String(n).padStart(2, "0");

function templateVars(a: Automation, timezone: string, payload: unknown): Record<string, unknown> {
  const w = wallClock(Date.now(), timezone);
  const date = `${w.year}-${pad(w.month)}-${pad(w.day)}`;
  const time = `${pad(w.hour)}:${pad(w.minute)}`;
  return { date, time, datetime: `${date} ${time}`, automation: a.name, payload };
}

/** Fills `{{path}}`s in; a path that leads nowhere becomes empty and is added to `missing`. */
export function render(template: string, vars: Record<string, unknown>, missing: Set<string>): string {
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, path: string) => {
    const value = lookup(vars, path);
    if (value === undefined || value === null) {
      missing.add(path);
      return "";
    }
    return typeof value === "object" ? JSON.stringify(value) : String(value);
  });
}

function lookup(vars: Record<string, unknown>, path: string): unknown {
  let value: unknown = vars;
  for (const key of path.split(".")) {
    if (value === null || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

function parsePayload(raw: string): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    // GitHub's form encoding: payload=<json>.
    const params = new URLSearchParams(raw);
    const inner = params.get("payload");
    if (inner) {
      try {
        return JSON.parse(inner);
      } catch {}
    }
    return { raw };
  }
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function header(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function verify(a: Automation, pathSecret: string | undefined, headers: Record<string, string | string[] | undefined>, raw: string): boolean {
  if (a.trigger.kind !== "webhook") return false;
  switch (a.trigger.verify) {
    case "url":
      return pathSecret !== undefined && safeEqual(pathSecret, a.secret);
    case "header": {
      const given = header(headers, "x-pitwall-token") ?? header(headers, "authorization")?.replace(/^Bearer /, "");
      return given !== undefined && safeEqual(given, a.secret);
    }
    case "github": {
      const given = header(headers, "x-hub-signature-256");
      const expected = `sha256=${createHmac("sha256", a.secret).update(raw).digest("hex")}`;
      return given !== undefined && safeEqual(given, expected);
    }
  }
}

// Filters: `payload.action == "opened" && payload.issue || payload.force == true`.

type Filter = (vars: Record<string, unknown>) => boolean;

/** Parses a filter; throws when it is not one. && binds tighter than ||; a bare path is true when it holds a value. */
export function parseFilter(text: string): Filter {
  const tokens = text.match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|&&|\|\||==|!=|[\w.-]+|\S/g) ?? [];
  let i = 0;
  const peek = () => tokens[i];
  const literal = (token: string | undefined): unknown => {
    if (token === undefined) throw new Error("expected a value");
    if (/^["']/.test(token)) return JSON.parse(token[0] === "'" ? `"${token.slice(1, -1).replace(/"/g, '\\"')}"` : token);
    if (token === "true") return true;
    if (token === "false") return false;
    if (token === "null") return null;
    if (/^-?\d+(\.\d+)?$/.test(token)) return Number(token);
    throw new Error(`"${token}" is not a value: put text in quotes`);
  };
  const condition = (): Filter => {
    const path = tokens[i++];
    if (!path || !/^[\w.-]+$/.test(path)) throw new Error(`expected a field, got "${path ?? "the end"}"`);
    const name = path.startsWith("payload") ? path : `payload.${path}`;
    if (peek() === "==" || peek() === "!=") {
      const op = tokens[i++];
      const value = literal(tokens[i++]);
      return (vars) => {
        const actual = lookup(vars, name);
        // A number in the payload matches "42" too: webhooks are loose about types.
        const same = actual === value || (actual !== undefined && actual !== null && String(actual) === String(value));
        return op === "==" ? same : !same;
      };
    }
    return (vars) => {
      const v = lookup(vars, name);
      return v !== undefined && v !== null && v !== false && v !== "";
    };
  };
  const and = (): Filter => {
    const parts = [condition()];
    while (peek() === "&&") {
      i++;
      parts.push(condition());
    }
    return (vars) => parts.every((p) => p(vars));
  };
  const or = (): Filter => {
    const parts = [and()];
    while (peek() === "||") {
      i++;
      parts.push(and());
    }
    return (vars) => parts.some((p) => p(vars));
  };
  const filter = or();
  if (i < tokens.length) throw new Error(`unexpected "${tokens[i]}"`);
  return filter;
}
