// Processes: plugins register steps and graphs of them, in code or as files (plugins/<id>/processes/*.json);
// the core runs a task's graph with LangGraph, keeps its state in the database and stops where a step asks the user.
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { basename, join } from "node:path";
import { Annotation, Command, END, interrupt, isGraphInterrupt, START, StateGraph } from "@langchain/langgraph";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { SqliteSaver } from "./checkpoints.ts";
import type { Db } from "./db.ts";
import type { EventBus } from "./events.ts";
import type { Settings } from "./settings.ts";
import { UserError, type Store } from "./store.ts";
import type { FlowState, Router, StepDef, ProcessDef, ProcessNode } from "../sdk/server.ts";
import type {
  EdgeSpec,
  Meta,
  NodeSpec,
  QuestionInfo,
  StepInfo,
  StepRole,
  SwitchSpec,
  Task,
  UserRequest,
  ProcessInfo,
  ProcessIssue,
  ProcessNodeInfo,
  ProcessRun,
  ProcessRunOptions,
  ProcessSpec,
  ProcessTraceEntry,
  ProcessVersion,
} from "../sdk/types.ts";

type Step = StepDef & { plugin: string };
type Process = ProcessDef & {
  plugin: string;
  source: "code" | "file";
  file?: string;
  /** The hash of its spec; null for a code process, which cannot be kept. */
  version: string | null;
  /** "<plugin>.<id>" of the plugin's process this file is the user's own version of. */
  overrides?: string;
  /** The `id` in its file: without the plugin's prefix, and its own one for a user's version. */
  specId?: string;
  /** In place of `overrides`: the plugin's process it replaces. */
  original?: Process;
  base?: string;
};
type Row = Record<string, any>;
type Edge = ProcessDef["edges"][number];

/** The graph's state: one channel of namespaced keys, merged as steps return them. */
const FlowAnnotation = Annotation.Root({
  data: Annotation<FlowState>({ reducer: (a, b) => ({ ...a, ...b }), default: () => ({}) }),
});

/**
 * Runs a function outside any graph's context. LangGraph keeps the running graph in AsyncLocalStorage, so a
 * process started or resumed from inside a step (a plugin's event handler, say) would run as part of that step.
 */
const outsideGraphs = AsyncLocalStorage.snapshot();

const KEY = /^[a-z0-9-]+(\.[A-Za-z0-9_-]+)+$/;
const NAME = /^[a-z0-9][a-z0-9-]*$/;
const ENDS: Record<string, string> = { start: START, end: END };
/** How deep processes may run inside each other. */
const MAX_DEPTH = 5;
/** The question step-by-step trials ask before each step. */
const STEP_GATE = "__step";

const toRun = (r: Row): ProcessRun => ({
  taskId: r.task_id,
  process: r.process,
  state: r.state,
  node: r.node,
  request: r.waiting ? JSON.parse(r.waiting) : null,
  progress: r.progress ?? null,
  error: r.error,
  startedAt: r.started_at,
  updatedAt: r.updated_at,
  version: r.version ?? null,
  path: r.node ? String(r.node).split("/") : [],
  options: r.options ? JSON.parse(r.options) : {},
});

const isSwitch = (to: unknown): to is SwitchSpec => !!to && typeof to === "object" && "on" in (to as object);
/** The nodes an edge can lead to. */
const targetsOf = (edge: Edge): string[] => {
  const to = edge[1];
  if (typeof to === "string") return [to];
  if (typeof to === "function") return edge[2] ?? [];
  if (isSwitch(to)) return [...new Set([...Object.values(to.cases), ...(to.else ? [to.else] : [])])];
  return (to as { targets?: string[] }).targets ?? [];
};
/** A key's value as a switch compares it. */
export const caseOf = (value: unknown) => (value === undefined || value === null ? "" : typeof value === "string" ? value : JSON.stringify(value));
const inputKeys = (inputs: ProcessDef["inputs"]) => (Array.isArray(inputs) ? inputs : Object.keys(inputs ?? {}));
const clip = (value: unknown) => {
  const text = JSON.stringify(value ?? null);
  return text.length > 4000 ? JSON.stringify({ clipped: text.slice(0, 4000) }) : text;
};

/** Stable JSON: keys sorted, so the same spec always has the same hash. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
export const specHash = (spec: ProcessSpec) => createHash("sha1").update(canonical(spec)).digest("hex").slice(0, 12);

export class Processes {
  private steps = new Map<string, Step>();
  /** Registered by plugins' code. */
  private code = new Map<string, Process>();
  /** Loaded from plugins/<id>/processes/*.json, by full id; overrides by their own file id. */
  private files = new Map<string, Process>();
  /** What runs: code and file processes, a user's own version in place of the one it overrides. */
  private defs = new Map<string, Process>();
  private compiled = new Map<string, any>();
  /** The promise of each task's graph while it runs, so it never runs twice at once. */
  private active = new Map<string, Promise<void>>();
  /** Tasks whose waiting node runs again with the answer; it keeps the status the answer gave. */
  private answered = new Set<string>();
  /** Tasks archived while a step of theirs ran: what the step ends with does not count. */
  private archived = new Set<string>();
  /** The node path of the step each task ran last: the one that asked, when the graph stops on a question. */
  private lastNode = new Map<string, string>();
  private pluginsDir: string | undefined;
  private filePlugins = new Set<string>();
  private watcher: FSWatcher | undefined;
  private reloadTimer: ReturnType<typeof setTimeout> | undefined;
  private db: Db;
  private events: EventBus;
  private store: Store;
  private saver: SqliteSaver;
  private settings: Settings | undefined;
  /**
   * Answers a question a task's process stopped on, when someone other than the user should (an automation):
   * the answer, "stop" to fail the run, or undefined to wait for the user.
   */
  autoAnswer: ((task: Task, run: ProcessRun, request: UserRequest) => unknown) | undefined;

  constructor(db: Db, events: EventBus, store: Store, saver: SqliteSaver, settings?: Settings) {
    this.db = db;
    this.events = events;
    this.store = store;
    this.saver = saver;
    this.settings = settings;
    // A step that was running when the app stopped did not finish; the user can retry it.
    db.prepare("UPDATE process_runs SET state = 'failed', error = ?, updated_at = ? WHERE state = 'running'").run(
      "Stopped when the app restarted",
      Date.now(),
    );
    db.prepare("UPDATE process_trace SET result = 'failed', error = ?, ended_at = ? WHERE result = 'running'").run(
      "Stopped when the app restarted",
      Date.now(),
    );
    events.on("task.deleting", (task) => void saver.deleteThread(task.id));
    // An archived task's process stops where it is: a waiting question waits on, a running step is failed.
    events.on("task.archived", (task) => {
      if (this.active.has(task.id)) this.archived.add(task.id);
    });
    // While a process runs, it alone moves the task: by the statuses of its nodes and the answers to its questions.
    store.guardTransition((task, _from, to) => {
      const run = this.run(task.id);
      if (!run || run.state === "done") return true;
      const label = this.defs.get(run.process)?.label ?? run.process;
      const offered = this.offered(run).map((o) => o.status);
      if (offered.length) return `${label} moves this task; now it can go to ${offered.join(", ")}`;
      return `${label} moves this task; its status follows the process`;
    });
  }

  // Registry

  registerStep(plugin: string, def: StepDef): void {
    const id = `${plugin}.${def.id}`;
    for (const key of [...(def.reads ?? []), ...(def.writes ?? [])]) {
      if (!KEY.test(key.replace(/\?$/, ""))) throw new Error(`Step ${id}: "${key}" is not a "namespace.name" key`);
    }
    this.steps.set(id, { ...def, id, plugin });
    this.compiled.clear();
    this.events.emit("step.registered", { id });
  }

  /** Takes back a plugin's own step: "<plugin>.<id>" or its id without the prefix. */
  removeStep(plugin: string, id: string): void {
    const full = id.startsWith(`${plugin}.`) ? id : `${plugin}.${id}`;
    if (this.steps.get(full)?.plugin !== plugin) return;
    this.steps.delete(full);
    this.compiled.clear();
    this.events.emit("step.registered", { id: full, removed: true });
  }

  register(plugin: string, def: ProcessDef): void {
    const id = `${plugin}.${def.id}`;
    for (const name of Object.keys(def.nodes)) {
      if (name in ENDS) throw new Error(`Process ${id}: a node cannot be named "${name}"`);
    }
    this.code.set(id, { ...def, id, plugin, source: "code", version: null });
    this.rebuild();
    this.events.emit("process.registered", { id });
  }

  /** What runs: the code and file processes, each user's own version in place of the one it overrides. */
  private rebuild(): void {
    this.defs = new Map(this.code);
    const overrides: Process[] = [];
    for (const w of this.files.values()) {
      if (w.overrides) overrides.push(w);
      else this.defs.set(w.id, w);
    }
    for (const w of overrides) {
      const original = this.defs.get(w.overrides!);
      this.defs.set(w.overrides!, { ...w, id: w.overrides!, original });
    }
    this.compiled.clear();
  }

  // Files

  /** Loads plugins/<id>/processes/*.json of the enabled plugins and watches them for changes. */
  loadFiles(pluginsDir: string, plugins: string[]): void {
    this.pluginsDir = pluginsDir;
    this.filePlugins = new Set(plugins);
    this.reloadFiles();
    try {
      this.watcher?.close();
      this.watcher = watch(pluginsDir, { recursive: true }, (_event, name) => {
        if (!name || !/[\\/]processes[\\/][^\\/]+\.json$/.test(String(name))) return;
        clearTimeout(this.reloadTimer);
        this.reloadTimer = setTimeout(() => this.reloadFiles(), 150);
      });
      this.watcher.unref();
    } catch {
      // No recursive watching here: files change through the app, which reloads them.
    }
  }

  reloadFiles(): void {
    if (!this.pluginsDir) return;
    const files = new Map<string, Process>();
    for (const plugin of this.filePlugins) {
      const dir = join(this.pluginsDir, plugin, "processes");
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
        const file = join(dir, name);
        try {
          const spec = JSON.parse(readFileSync(file, "utf8")) as ProcessSpec;
          spec.id ??= basename(name, ".json");
          checkSpec(spec);
          const w = this.fromSpec(plugin, spec, file);
          files.set(`${plugin}.${spec.id}`, w);
          this.keepVersion(spec.overrides ?? `${plugin}.${spec.id}`, plugin, spec, null);
        } catch (error) {
          console.error(`Process ${file} is not loaded:`, (error as Error).message);
        }
      }
    }
    this.files = files;
    this.rebuild();
    this.events.emit("process.registered", { files: files.size });
  }

  private fromSpec(plugin: string, spec: ProcessSpec, file?: string): Process {
    for (const name of Object.keys(spec.nodes)) {
      if (name in ENDS) throw new Error(`a node cannot be named "${name}"`);
    }
    return {
      ...(spec as unknown as ProcessDef),
      id: `${plugin}.${spec.id}`,
      plugin,
      source: "file",
      file,
      specId: spec.id,
      version: specHash(spec),
      overrides: spec.overrides,
      base: spec.base,
    } as Process;
  }

  /** Writes a process as plugins/<plugin>/processes/<id>.json and loads it. Returns the id it runs under. */
  save(plugin: string, spec: ProcessSpec, note?: string): string {
    if (!this.pluginsDir) throw new UserError("Process files are not loaded");
    if (!NAME.test(plugin)) throw new UserError(`"${plugin}" is not a plugin id`);
    try {
      checkSpec(spec);
    } catch (error) {
      throw new UserError((error as Error).message);
    }
    const dir = join(this.pluginsDir, plugin);
    if (!existsSync(join(dir, "plugin.json"))) {
      mkdirSync(dir, { recursive: true });
      const manifest = {
        name: "My processes",
        description: "Processes and steps made in the app's editor: your own, and your versions of plugins' ones.",
        permissions: {},
      };
      writeFileSync(join(dir, "plugin.json"), JSON.stringify(manifest, null, 2) + "\n");
    }
    mkdirSync(join(dir, "processes"), { recursive: true });
    writeFileSync(join(dir, "processes", `${spec.id}.json`), JSON.stringify(spec, null, 2) + "\n");
    const id = spec.overrides ?? `${plugin}.${spec.id}`;
    this.keepVersion(id, plugin, spec, note ?? null);
    this.filePlugins.add(plugin);
    this.reloadFiles();
    return id;
  }

  /** Deletes a file process, or a user's own version, which brings the original back. Its versions stay. */
  remove(processId: string): void {
    const w = this.defs.get(processId);
    if (!w || w.source !== "file" || !w.file) throw new UserError(`${processId} is not a process file`);
    rmSync(w.file, { force: true });
    this.reloadFiles();
  }

  private keepVersion(process: string, plugin: string, spec: ProcessSpec, note: string | null): string {
    const version = specHash(spec);
    const known = this.db.prepare("SELECT note FROM process_versions WHERE process = ? AND version = ?").get(process, version) as
      | { note: string | null }
      | undefined;
    if (!known) {
      this.db
        .prepare("INSERT INTO process_versions (process, version, plugin, spec, at, note) VALUES (?, ?, ?, ?, ?, ?)")
        .run(process, version, plugin, JSON.stringify(spec), Date.now(), note);
    } else if (note && !known.note) {
      this.db.prepare("UPDATE process_versions SET note = ? WHERE process = ? AND version = ?").run(note, process, version);
    }
    return version;
  }

  versions(processId: string): ProcessVersion[] {
    return (
      this.db.prepare("SELECT * FROM process_versions WHERE process = ? ORDER BY at DESC, rowid DESC").all(processId) as Row[]
    ).map((r) => ({ process: r.process, version: r.version, spec: JSON.parse(r.spec), at: r.at, note: r.note }));
  }

  /** A process as it was in a version: a running task's, or a draft's trial. */
  private atVersion(processId: string, version: string | null): Process | undefined {
    const current = this.defs.get(processId);
    if (!version || current?.version === version) return current;
    const row = this.db.prepare("SELECT * FROM process_versions WHERE process = ? AND version = ?").get(processId, version) as Row | undefined;
    if (!row) return current;
    return { ...this.fromSpec(row.plugin, JSON.parse(row.spec)), id: processId };
  }

  // What the editor and the UI see

  stepInfo(): StepInfo[] {
    return [...this.steps.values()].map((s) => this.describeStep(s));
  }

  private describeStep(s: Step): StepInfo {
    const questions = this.questionsOf(s, {});
    return {
      id: s.id,
      label: s.label,
      description: s.description,
      plugin: s.plugin,
      reads: s.reads ?? [],
      writes: s.writes ?? [],
      icon: s.icon,
      group: s.group,
      role: s.role ?? (questions.some((q) => !q.when) ? "you" : "app"),
      labels: s.labels ?? {},
      params: s.params ?? {},
      outcomes: this.outcomesOf(s, {}),
      questions,
      sideEffects: !!s.sideEffects,
    };
  }

  /** The step's questions for a node's parameters, over the defaults of its own. */
  private questionsOf(s: Step, params: Record<string, unknown>): QuestionInfo[] {
    if (!s.questions) return [];
    if (Array.isArray(s.questions)) return s.questions;
    try {
      return s.questions(this.defaultsOf(s, params));
    } catch {
      return [];
    }
  }

  /** What the step can end with, for a node's parameters. */
  private outcomesOf(s: Step, params: Record<string, unknown>): Record<string, Record<string, string>> {
    if (!s.outcomes) return {};
    if (typeof s.outcomes !== "function") return s.outcomes;
    try {
      return s.outcomes(this.defaultsOf(s, params));
    } catch {
      return {};
    }
  }

  private defaultsOf(s: Step, params: Record<string, unknown>): Record<string, unknown> {
    const defaults = Object.fromEntries(
      Object.entries(s.params ?? {})
        .filter(([, p]) => p.default !== undefined && !isSettingRef(p.default))
        .map(([k, p]) => [k, p.default]),
    );
    return { ...defaults, ...params };
  }

  list(): ProcessInfo[] {
    return [...this.defs.values()].map((w) => this.describe(w));
  }

  get(processId: string): ProcessInfo | undefined {
    const w = this.defs.get(processId);
    return w ? this.describe(w) : undefined;
  }

  private describe(w: Process): ProcessInfo {
    const issues = this.issues(w);
    const nodes = Object.entries(w.nodes).map(([id, n]) => this.nodeInfo(w, id, n, new Set([w.id])));
    const original = w.original;
    return {
      id: w.id,
      label: w.label,
      description: w.description,
      plugin: w.plugin,
      icon: w.icon,
      hotkey: w.hotkey,
      nodes,
      doneStatus: w.doneStatus ?? "done",
      problems: issues.map((i) => i.message),
      issues,
      source: w.source,
      ...(w.file ? { file: w.file } : {}),
      spec: specOf(w),
      editable: !w.edges.some(([, to]) => typeof to === "function"),
      version: w.version,
      ...(original
        ? {
            original: {
              plugin: original.plugin,
              spec: specOf(original),
              version: original.version,
              updated: !!w.base && !!original.version && w.base !== original.version,
            },
          }
        : {}),
      template: !!w.template,
      inputs: Array.isArray(w.inputs)
        ? w.inputs.map((key) => ({ key, type: "string" as const, label: key, optional: false }))
        : Object.entries(w.inputs ?? {}).map(([key, d]) => ({ key, type: d.type, label: d.label, optional: !!d.optional })),
      asks: nodes.reduce((n, node) => n + (node.skip ? 0 : node.questions.filter((q) => !q.when).length), 0),
    };
  }

  private nodeInfo(w: Process, id: string, n: string | ProcessNode, seen: Set<string>): ProcessNodeInfo {
    const node = this.node(w, n);
    if (node.process) {
      const inner = this.innerOf(node);
      const questions =
        inner && !seen.has(inner.id) && seen.size < MAX_DEPTH
          ? Object.entries(inner.nodes).flatMap(([nid, nn]) => {
              const info = this.nodeInfo(inner, nid, nn, new Set([...seen, inner.id]));
              return info.skip ? [] : info.questions.map((q) => ({ ...q, node: q.node ? `${nid}/${q.node}` : nid, step: q.step ?? info.step }));
            })
          : [];
      return {
        id,
        step: "",
        process: node.process,
        label: node.label ?? inner?.label ?? node.process,
        status: node.status,
        role: questions.some((q) => !q.when) ? "you" : "app",
        icon: inner?.icon ?? "workflow",
        questions,
        outcomes: {},
        skip: !!node.skip,
      };
    }
    const step = this.steps.get(node.step ?? "");
    const questions = step ? this.questionsOf(step, node.params ?? {}) : [];
    const role: StepRole = step?.role ?? (questions.some((q) => !q.when) ? "you" : "app");
    return {
      id,
      step: node.step ?? "",
      label: node.label ?? step?.label ?? id,
      status: node.status,
      role,
      icon: step?.icon,
      questions,
      outcomes: step ? this.outcomesOf(step, node.params ?? {}) : {},
      skip: !!node.skip,
    };
  }

  /** The process a node runs: its pinned copy, or the installed one. */
  private innerOf(node: ProcessNode): Process | undefined {
    if (node.pin) return { ...this.fromSpec(node.process!.split(".")[0] ?? "", node.pin), id: node.process! };
    return node.process ? this.defs.get(node.process) : undefined;
  }

  /** The issues of a process that is not installed: a draft in the editor. */
  issuesOf(plugin: string, spec: ProcessSpec): ProcessIssue[] {
    try {
      checkSpec(spec);
    } catch (error) {
      return [{ code: "badSpec", message: (error as Error).message }];
    }
    return this.issues({ ...this.fromSpec(plugin, spec), id: spec.overrides ?? `${plugin}.${spec.id}` });
  }

  /** A draft as the UI shows a process, for the editor. */
  preview(plugin: string, spec: ProcessSpec): ProcessInfo {
    try {
      checkSpec(spec);
    } catch (error) {
      throw new UserError((error as Error).message);
    }
    const id = spec.overrides ?? `${plugin}.${spec.id}`;
    const w = { ...this.fromSpec(plugin, spec), id, original: this.defs.get(id)?.original ?? (spec.overrides ? this.defs.get(id) : undefined) };
    return this.describe(w);
  }

  /**
   * The contract between steps, checked before a process runs: every step exists, every read some node
   * writes (or the process takes as input), every edge leads to a node, every node is reached and can end.
   */
  issues(w: Process, chain: string[] = []): ProcessIssue[] {
    const issues: ProcessIssue[] = [];
    const add = (code: string, message: string, node?: string, data?: Record<string, unknown>) =>
      issues.push({ code, message, ...(node ? { node } : {}), ...(data ? { data } : {}) });
    const nodes = Object.entries(w.nodes).map(([name, n]) => [name, this.node(w, n)] as const);
    const written = new Set(inputKeys(w.inputs));
    const writers = new Map<string, string[]>();
    for (const s of this.steps.values()) for (const key of s.writes ?? []) writers.set(key, [...(writers.get(key) ?? []), s.id]);
    for (const [, node] of nodes) {
      if (node.skip) continue;
      if (node.process) {
        const inner = this.innerOf(node);
        for (const key of inner?.outputs ?? []) written.add(node.out?.[key] ?? key);
      } else for (const key of this.steps.get(node.step ?? "")?.writes ?? []) written.add(key);
    }
    for (const [name, node] of nodes) {
      if (node.skip) continue;
      if (node.process) {
        const inner = this.innerOf(node);
        if (!inner) {
          add("noProcess", `Node ${name}: no process ${node.process}; is its plugin installed and enabled?`, name, { process: node.process });
          continue;
        }
        const calls = [...chain, w.id];
        if (calls.includes(inner.id) || calls.length >= MAX_DEPTH) {
          add("selfCall", `Node ${name}: ${inner.id} runs ${calls.join(" → ")} again`, name, { chain: [...calls, inner.id] });
          continue;
        }
        const innerIssues = this.issues(inner, calls).filter((i) => i.code !== "unmetRead");
        if (innerIssues.length) add("innerIssues", `Node ${name}: ${inner.label} cannot run: ${innerIssues[0].message}`, name, { process: inner.id });
        for (const key of inputKeys(inner.inputs)) {
          const optional = !Array.isArray(inner.inputs) && inner.inputs?.[key]?.optional;
          const from = node.in?.[key] ?? key;
          if (!optional && !written.has(from)) {
            add("unmetRead", `Node ${name}: ${inner.id} takes ${from}, which no step writes`, name, {
              key: from,
              step: inner.id,
              writers: writers.get(from) ?? [],
            });
          }
        }
        continue;
      }
      const step = this.steps.get(node.step ?? "");
      if (!step) {
        add("noStep", `Node ${name}: no step ${node.step ?? "(none)"}; is its plugin installed and enabled?`, name, { step: node.step ?? "" });
        continue;
      }
      for (const key of step.reads ?? []) {
        if (!key.endsWith("?") && !written.has(key)) {
          add("unmetRead", `Node ${name}: ${node.step} reads ${key}, which no step writes`, name, {
            key,
            step: step.id,
            writers: writers.get(key) ?? [],
          });
        }
      }
      const blocked = step.blocked?.(node.params ?? {});
      if (blocked) add("blocked", `Node ${name}: ${blocked}`, name, { why: blocked });
      for (const [param, def] of Object.entries(step.params ?? {})) {
        const value = node.params?.[param] ?? def.default;
        if (def.required && (value === undefined || value === null || value === "")) {
          add("noParam", `Node ${name}: ${def.label} is empty`, name, { param });
        }
      }
    }
    const statuses = new Set(this.store.statuses().map((st) => st.id));
    for (const [name, node] of nodes) {
      if (node.status && !statuses.has(node.status)) add("noStatus", `Node ${name}: no status ${node.status}`, name, { status: node.status });
    }
    if (!statuses.has(w.doneStatus ?? "done")) add("noStatus", `No status ${w.doneStatus}, which the process ends with`, undefined, { status: w.doneStatus });
    const known = (n: string) => n in ENDS || n in w.nodes;
    for (const edge of w.edges) {
      const [from, to] = edge;
      if (!known(from) || from === "end") add("noEdge", `Edge from ${from}: no such node`, undefined, { from });
      if (to && typeof to === "object" && !isSwitch(to)) add("fileRouter", `Edge from ${from}: a router in code cannot be in a file`, from);
      for (const target of targetsOf(edge)) {
        if (!known(target) || target === "start") add("noEdge", `Edge to ${target}: no such node`, known(from) ? from : undefined, { to: target });
      }
    }
    if (!w.edges.some(([from]) => from === "start")) add("noStart", "Nothing starts it: add an edge from start");
    else {
      const next = new Map<string, string[]>();
      for (const edge of w.edges) next.set(edge[0], [...(next.get(edge[0]) ?? []), ...targetsOf(edge)]);
      const reach = (from: string, step: (n: string) => string[]) => {
        const seen = new Set<string>([from]);
        for (const queue = [from]; queue.length; ) for (const n of step(queue.shift()!)) if (!seen.has(n)) (seen.add(n), queue.push(n));
        return seen;
      };
      const reached = reach("start", (n) => next.get(n) ?? []);
      const prev = new Map<string, string[]>();
      for (const [from, tos] of next) for (const to of tos) prev.set(to, [...(prev.get(to) ?? []), from]);
      const ending = reach("end", (n) => prev.get(n) ?? []);
      for (const name of Object.keys(w.nodes)) {
        if (!reached.has(name)) add("unreachable", `Node ${name}: nothing leads to it`, name);
        else if (!ending.has(name)) add("noExit", `Node ${name}: no way from it to the end`, name);
      }
    }
    return issues;
  }

  // Runs

  run(taskId: string): ProcessRun | undefined {
    const row = this.db.prepare("SELECT * FROM process_runs WHERE task_id = ?").get(taskId);
    return row ? toRun(row as Row) : undefined;
  }

  runs(): ProcessRun[] {
    return (this.db.prepare("SELECT * FROM process_runs").all() as Row[]).map(toRun);
  }

  /** The value a step of the task's process wrote last for a key; undefined when none did. */
  lastValue(taskId: string, key: string): unknown {
    const rows = this.db
      .prepare("SELECT output FROM process_trace WHERE task_id = ? AND output LIKE ? ORDER BY seq DESC LIMIT 20")
      .all(taskId, `%${JSON.stringify(key)}%`) as { output: string }[];
    for (const row of rows) {
      const output = JSON.parse(row.output) as FlowState;
      if (key in output) return output[key];
    }
    return undefined;
  }

  trace(taskId: string): ProcessTraceEntry[] {
    return (this.db.prepare("SELECT * FROM process_trace WHERE task_id = ? ORDER BY seq").all(taskId) as Row[]).map((r) => ({
      seq: r.seq,
      node: r.node,
      step: r.step,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      result: r.result,
      output: r.output ? JSON.parse(r.output) : null,
      answer: r.answer ? JSON.parse(r.answer) : null,
      error: r.error,
    }));
  }

  start(
    taskId: string,
    processId: string,
    input: FlowState = {},
    options: ProcessRunOptions = {},
    version?: string | null,
  ): ProcessRun {
    if (!this.store.task(taskId)) throw new UserError(`No task ${taskId}`);
    const w = this.check(processId, input, version);
    const existing = this.run(taskId);
    if (existing) throw new UserError(`The task already follows ${this.defs.get(existing.process)?.label ?? existing.process}`);

    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO process_runs (task_id, process, state, started_at, updated_at, version, options) VALUES (?, ?, 'running', ?, ?, ?, ?)",
      )
      .run(taskId, processId, now, now, version ?? w.version, JSON.stringify(options));
    this.drive(taskId, { data: input });
    return this.run(taskId)!;
  }

  /**
   * A new task that follows the process from the start: what a folder's process button makes.
   * A process that cannot run leaves no task behind. `spec` runs a draft of it (the editor's trial).
   */
  createTask(
    input: { folderId: string; title: string; body?: string; meta?: Meta },
    processId: string,
    data: FlowState = {},
    options: ProcessRunOptions = {},
    spec?: ProcessSpec,
  ) {
    let version: string | null | undefined;
    if (spec) {
      const plugin = this.defs.get(processId)?.plugin ?? processId.split(".")[0];
      try {
        checkSpec(spec);
      } catch (error) {
        throw new UserError((error as Error).message);
      }
      version = this.keepVersion(processId, plugin, spec, "draft");
    }
    this.check(processId, data, version);
    const meta = options.trial ? { ...input.meta, trial: true } : input.meta;
    const task = this.store.createTask({ ...input, meta });
    this.start(task.id, processId, data, options, version);
    return this.store.task(task.id)!;
  }

  /** Throws what keeps the process from starting with this input; returns it. */
  private check(processId: string, input: FlowState, version?: string | null): Process {
    const w = this.atVersion(processId, version ?? null);
    if (!w) throw new UserError(`No process ${processId}`);
    const problems = this.issues(w).map((i) => i.message);
    if (problems.length) throw new UserError(`${w.label} cannot run: ${problems.join("; ")}`);
    const extra = Object.keys(input).filter((k) => !inputKeys(w.inputs).includes(k));
    if (extra.length) throw new UserError(`${w.label} does not take ${extra.join(", ")}`);
    return w;
  }

  resume(taskId: string, answer: unknown, automatic = false): ProcessRun {
    if (this.store.task(taskId)?.archivedAt) throw new UserError("The task is in the archive: restore it first");
    const run = this.run(taskId);
    if (run?.state !== "waiting" || !run.request) throw new UserError("The process is not waiting for an answer");
    checkAnswer(run.request, answer);
    const status = run.request.kind === "choice" ? run.request.options.find((o) => o.id === answer)?.status : undefined;
    this.update(taskId, { state: "running", waiting: null });
    if (status) this.store.setStatus(taskId, status, { guards: false });
    this.answered.add(taskId);
    this.db
      .prepare("UPDATE process_trace SET result = 'answered', answer = ? WHERE seq = (SELECT MAX(seq) FROM process_trace WHERE task_id = ? AND result = 'asked')")
      .run(clip(answer), taskId);
    this.events.emit("process.answered", {
      taskId,
      process: run.process,
      node: run.node,
      question: run.request.id ?? "main",
      answer,
      automatic,
    });
    this.drive(taskId, new Command({ resume: answer }));
    return this.run(taskId)!;
  }

  /**
   * A status the user picked for a task that follows a process: the answer whose option moves the
   * task there. Any other status is refused.
   */
  setStatus(taskId: string, status: string): ProcessRun {
    const run = this.run(taskId);
    const option = run && this.offered(run).find((o) => o.status === status);
    if (!run || !option) {
      this.store.setStatus(taskId, status); // the guard explains why not
      return run!;
    }
    return this.resume(taskId, option.id);
  }

  /** Whether the task follows a process that has not ended. */
  owns(taskId: string): boolean {
    const run = this.run(taskId);
    return !!run && run.state !== "done";
  }

  /** The waiting question's options that move the task to a status. */
  private offered(run: ProcessRun): { id: string; status: string }[] {
    if (run.state !== "waiting" || run.request?.kind !== "choice") return [];
    return run.request.options.filter((o): o is typeof o & { status: string } => !!o.status);
  }

  /** Runs the failed step again, from the last saved state. */
  retry(taskId: string): ProcessRun {
    if (this.store.task(taskId)?.archivedAt) throw new UserError("The task is in the archive: restore it first");
    const run = this.run(taskId);
    if (run?.state !== "failed") throw new UserError("Only a failed process can be retried");
    this.update(taskId, { state: "running", error: null });
    this.drive(taskId, null);
    return this.run(taskId)!;
  }

  /**
   * Moves a task to the current version of its process, when the step it waits on (or failed at) is still there.
   * Returns the run; throws why not.
   */
  upgrade(taskId: string): ProcessRun {
    const run = this.run(taskId);
    if (!run || run.state === "done") throw new UserError("The task follows no process now");
    if (run.state === "running" || this.active.has(taskId)) throw new UserError("Wait until the step finishes");
    const current = this.defs.get(run.process);
    if (!current) throw new UserError(`No process ${run.process}`);
    if (!current.version || current.version === run.version) return run;
    if (!run.path.length || !this.hasPath(current, run.path)) throw new UserError("The step the task is on is not in the new version");
    this.db.prepare("UPDATE process_runs SET version = ?, updated_at = ? WHERE task_id = ?").run(current.version, Date.now(), taskId);
    this.events.emit("process.updated", this.run(taskId));
    return this.run(taskId)!;
  }

  private hasPath(w: Process, path: string[]): boolean {
    const [first, ...rest] = path;
    if (!(first in w.nodes)) return false;
    if (!rest.length) return true;
    const inner = this.innerOf(this.node(w, w.nodes[first]));
    return !!inner && this.hasPath(inner, rest);
  }

  /** Stops saving state; what runs now is marked failed at the next start. */
  close(): void {
    this.saver.closed = true;
    this.watcher?.close();
    clearTimeout(this.reloadTimer);
  }

  /** Resolves when the task's graph has stopped: done, failed or waiting. For tests and shutdown. */
  async settled(taskId: string): Promise<ProcessRun | undefined> {
    while (this.active.has(taskId)) await this.active.get(taskId);
    return this.run(taskId);
  }

  private drive(taskId: string, input: unknown): void {
    if (this.active.has(taskId)) throw new UserError("The process is already running");
    const run = this.run(taskId)!;
    const config: RunnableConfig = { configurable: { thread_id: taskId } };
    let auto: { answer: unknown } | undefined;
    const promise = outsideGraphs(async () => {
      try {
        const graph = this.graph(run.process, run.version);
        await graph.invoke(input, config);
        if (this.archived.has(taskId)) throw new Error("Stopped when the task was archived");
        const snapshot = await graph.getState(config);
        const waiting = snapshot.tasks.find((t: any) => t.interrupts?.length);
        if (waiting) {
          const request = waiting.interrupts[0].value as UserRequest;
          this.update(taskId, {
            state: "waiting",
            node: this.lastNode.get(taskId) ?? waiting.name,
            waiting: request,
            progress: null,
          });
          const task = this.store.task(taskId);
          const answer = task && request.id !== STEP_GATE ? this.autoAnswer?.(task, this.run(taskId)!, request) : undefined;
          if (answer === "stop") throw new Error("Stopped: nobody was there to answer");
          if (answer !== undefined) auto = { answer };
        } else {
          const w = this.atVersion(run.process, run.version);
          this.update(taskId, { state: "done", node: null, progress: null });
          this.store.setStatus(taskId, w?.doneStatus ?? "done", { guards: false });
        }
      } catch (error) {
        if (this.saver.closed || !this.store.task(taskId)) return; // the app stopped, or the task was deleted
        if (this.archived.has(taskId)) error = new Error("Stopped when the task was archived");
        console.error(`Process ${run.process} failed for task ${taskId}:`, error);
        this.update(taskId, { state: "failed", error: (error as Error).message ?? String(error), progress: null });
      }
    }).finally(() => {
      this.active.delete(taskId);
      this.answered.delete(taskId);
      this.archived.delete(taskId);
      this.lastNode.delete(taskId);
      // Answered for the user (an automation's answer): once this run has stopped.
      if (auto) {
        try {
          this.resume(taskId, auto.answer, true);
        } catch (error) {
          console.error(`Answering ${taskId} for the user failed:`, error);
        }
      }
    });
    this.active.set(taskId, promise);
  }

  private graph(processId: string, version: string | null): any {
    const key = `${processId}@${version ?? ""}`;
    const cached = this.compiled.get(key);
    if (cached) return cached;
    const w = this.atVersion(processId, version);
    if (!w) throw new Error(`Process ${processId} is not installed`);
    const problems = this.issues(w);
    if (problems.length) throw new Error(problems.map((i) => i.message).join("; "));
    const compiled = this.build(w, [], false).compile({ checkpointer: this.saver });
    this.compiled.set(key, compiled);
    return compiled;
  }

  /**
   * The process's graph. `path` is the nodes of the outer processes it runs in; `fixed` when the outer node
   * holds the task's status, so its own nodes do not move it.
   */
  private build(w: Process, path: string[], fixed: boolean): any {
    // Node names are only known at run time, which LangGraph's types cannot follow.
    const graph: any = new StateGraph(FlowAnnotation);
    for (const [name, n] of Object.entries(w.nodes)) {
      const node = this.node(w, n);
      graph.addNode(name, node.process ? this.innerFunction(name, node, path, fixed) : this.nodeFunction(name, node, path, fixed));
    }
    for (const edge of w.edges) {
      const [from, to] = edge;
      const source = ENDS[from] ?? from;
      if (typeof to === "function" || isSwitch(to)) {
        const targets = targetsOf(edge);
        const choose: Router = typeof to === "function" ? to : (data) => {
          const next = to.cases[caseOf(data[to.on])] ?? to.else;
          if (next === undefined) throw new Error(`After ${from}, ${to.on} is "${caseOf(data[to.on])}", which leads nowhere`);
          return next;
        };
        graph.addConditionalEdges(
          source,
          ({ data }: { data: FlowState }) => {
            const next = choose(data);
            if (!targets.includes(next)) throw new Error(`The router after ${from} chose "${next}", not one of ${targets.join(", ")}`);
            return ENDS[next] ?? next;
          },
          targets.map((t) => ENDS[t] ?? t),
        );
      } else {
        graph.addEdge(source, ENDS[to as string] ?? to);
      }
    }
    return graph;
  }

  /** A node that runs another process: its own graph, with its keys its own but for its inputs and outputs. */
  private innerFunction(name: string, node: ProcessNode, path: string[], fixed: boolean) {
    return async ({ data }: { data: FlowState }, config: RunnableConfig) => {
      const taskId = config.configurable?.thread_id as string;
      const inner = this.innerOf(node);
      if (!inner) throw new Error(`No process ${node.process}`);
      if (node.skip) return { data: {} };
      // The status is set once, not again when an answer runs the inner process's step again.
      if (node.status && !fixed && !this.answered.has(taskId)) this.store.setStatus(taskId, node.status, { guards: false });
      const input = Object.fromEntries(
        inputKeys(inner.inputs)
          .map((key) => [key, data[node.in?.[key] ?? key]] as const)
          .filter(([, v]) => v !== undefined),
      );
      const graph = this.build(inner, [...path, name], fixed || !!node.status).compile();
      const result = await graph.invoke({ data: input }, config);
      const out = (result?.data ?? {}) as FlowState;
      return { data: Object.fromEntries((inner.outputs ?? []).filter((k) => k in out).map((k) => [node.out?.[k] ?? k, out[k]])) };
    };
  }

  private nodeFunction(name: string, node: ProcessNode, path: string[], fixed: boolean) {
    const where = [...path, name].join("/");
    return async ({ data }: { data: FlowState }, config: RunnableConfig) => {
      const taskId = config.configurable?.thread_id as string;
      const step = this.steps.get(node.step ?? "");
      if (!step) throw new Error(`No step ${node.step}`);
      const task = this.store.task(taskId);
      if (!task) throw new Error(`No task ${taskId}`);
      const run = this.run(taskId);
      const options = run?.options ?? {};
      this.lastNode.set(taskId, where);
      this.update(taskId, { state: "running", node: where, waiting: null, error: null, progress: null });
      const again = this.answered.delete(taskId);
      if (node.status && !again && !fixed) this.store.setStatus(taskId, node.status, { guards: false });
      const seq = this.traceStart(taskId, where, step.id, again);

      try {
        const skipped = (why: string) => {
          this.traceEnd(seq, "skipped", {}, why);
          return { data: {} };
        };
        if (node.skip) return skipped("skipped in the process");
        if (options.stepByStep) {
          const go = interrupt(
            this.checkRequest({
              kind: "choice",
              id: STEP_GATE,
              title: node.label ?? step.label,
              body: step.description,
              options: [
                { id: "run", label: "Run", primary: true },
                { id: "skip", label: "Skip" },
                { id: "stop", label: "Stop" },
              ],
            }),
          );
          if (go === "skip") return skipped("skipped by the user");
          if (go === "stop") throw new Error("Stopped by the user");
        }
        if (options.dryRun && step.sideEffects) return skipped("a trial without consequences");

        const reads = new Set((step.reads ?? []).map((k) => k.replace(/\?$/, "")));
        const state = Object.fromEntries(Object.entries(data).filter(([k]) => reads.has(k)));
        const out = (await step.run({
          task,
          state,
          params: this.params(step, node, task),
          trial: !!options.trial,
          ask: (request) => interrupt(this.checkRequest(request)),
          setTask: ({ title, body }) => this.store.updateTask(taskId, { title, body }),
          progress: (text) => {
            if (text !== null && typeof text !== "string") throw new Error("progress() takes a text or null");
            this.update(taskId, { progress: text });
          },
        })) ?? {};

        const allowed = new Set(step.writes ?? []);
        const stray = Object.keys(out).filter((k) => !allowed.has(k));
        if (stray.length) throw new Error(`Step ${step.id} returned ${stray.join(", ")}, which it does not declare in writes`);
        this.traceEnd(seq, "done", out);
        return { data: out };
      } catch (error) {
        if (isGraphInterrupt(error)) this.traceEnd(seq, "asked", null);
        else this.traceEnd(seq, "failed", null, (error as Error).message ?? String(error));
        throw error;
      }
    };
  }

  /** The node's parameters over its step's defaults; `{ setting }` values read for the task's folder. */
  private params(step: Step, node: ProcessNode, task: Task): Record<string, unknown> {
    const resolve = (value: unknown) =>
      isSettingRef(value) ? this.settings?.get(value.setting, task.folderId) : value;
    const params: Record<string, unknown> = {};
    for (const [key, def] of Object.entries(step.params ?? {})) if (def.default !== undefined) params[key] = resolve(def.default);
    for (const [key, value] of Object.entries(node.params ?? {})) params[key] = resolve(value);
    return params;
  }

  /** A step starts, or runs again after its question was answered. Returns its trace row. */
  private traceStart(taskId: string, node: string, step: string, again: boolean): number {
    if (this.saver.closed) return 0;
    if (again) {
      const row = this.db
        .prepare("SELECT seq FROM process_trace WHERE task_id = ? AND node = ? AND result = 'answered' ORDER BY seq DESC LIMIT 1")
        .get(taskId, node) as { seq: number } | undefined;
      if (row) {
        this.db.prepare("UPDATE process_trace SET result = 'running' WHERE seq = ?").run(row.seq);
        return row.seq;
      }
    }
    const result = this.db
      .prepare("INSERT INTO process_trace (task_id, node, step, started_at, result) VALUES (?, ?, ?, ?, 'running')")
      .run(taskId, node, step, Date.now());
    return Number(result.lastInsertRowid);
  }

  private traceEnd(seq: number, result: ProcessTraceEntry["result"], output: FlowState | null, error?: string): void {
    if (this.saver.closed || !seq) return;
    this.db
      .prepare("UPDATE process_trace SET result = ?, ended_at = ?, output = ?, error = ? WHERE seq = ?")
      .run(result, result === "asked" ? null : Date.now(), output ? clip(output) : null, error ?? null, seq);
  }

  /** A process's node in full; its step id with the prefix when it named a step of its own plugin without one. */
  private node(w: Process, n: string | ProcessNode | NodeSpec): ProcessNode {
    const node = (typeof n === "string" ? { step: n } : n) as ProcessNode;
    if (node.process) {
      const own = `${w.plugin}.${node.process}`;
      return this.defs.has(own) && !this.defs.has(node.process) ? { ...node, process: own } : node;
    }
    const own = `${w.plugin}.${node.step}`;
    return this.steps.has(own) && !this.steps.has(node.step ?? "") ? { ...node, step: own } : node;
  }

  private checkRequest(request: UserRequest): UserRequest {
    if (request?.kind === "form" && request.fields?.length) return request;
    if (request?.kind !== "choice" || !request.options?.length) {
      throw new Error("ask() needs a choice with options or a form with fields");
    }
    const statuses = new Set(this.store.statuses().map((st) => st.id));
    const unknown = request.options.filter((o) => o.status && !statuses.has(o.status));
    if (unknown.length) throw new Error(`ask(): no status ${unknown.map((o) => o.status).join(", ")}`);
    return request;
  }

  private update(
    taskId: string,
    patch: {
      state?: string;
      node?: string | null;
      waiting?: UserRequest | null;
      error?: string | null;
      progress?: string | null;
    },
  ): void {
    if (this.saver.closed) return;
    const run = this.run(taskId);
    if (!run) return;
    const next = {
      state: patch.state ?? run.state,
      node: patch.node !== undefined ? patch.node : run.node,
      waiting: patch.waiting !== undefined ? patch.waiting : run.request,
      error: patch.error !== undefined ? patch.error : run.error,
      progress: patch.progress !== undefined ? patch.progress : run.progress,
    };
    this.db
      .prepare(
        "UPDATE process_runs SET state = ?, node = ?, waiting = ?, error = ?, progress = ?, updated_at = ? WHERE task_id = ?",
      )
      .run(
        next.state,
        next.node,
        next.waiting ? JSON.stringify(next.waiting) : null,
        next.error,
        next.progress,
        Date.now(),
        taskId,
      );
    this.events.emit("process.updated", this.run(taskId));
  }
}

const isSettingRef = (value: unknown): value is { setting: string } =>
  !!value && typeof value === "object" && typeof (value as { setting?: unknown }).setting === "string";

/** A process as data: a code process's routers become `{ targets }`. */
function specOf(w: Process): ProcessSpec {
  const id = w.id.slice(w.plugin.length + 1) || w.id;
  const spec: ProcessSpec = {
    id: w.specId ?? id,
    label: w.label,
    ...(w.description ? { description: w.description } : {}),
    ...(w.icon ? { icon: w.icon } : {}),
    ...(w.hotkey ? { hotkey: w.hotkey } : {}),
    ...(w.inputs ? { inputs: w.inputs } : {}),
    ...(w.outputs ? { outputs: w.outputs } : {}),
    nodes: w.nodes as Record<string, string | NodeSpec>,
    edges: w.edges.map((edge): EdgeSpec => {
      const [from, to] = edge;
      if (typeof to === "function") return [from, { targets: edge[2] ?? [] }];
      return [from, to as string | SwitchSpec] as EdgeSpec;
    }),
    ...(w.doneStatus ? { doneStatus: w.doneStatus } : {}),
    ...(w.template ? { template: true } : {}),
    ...(w.overrides ? { overrides: w.overrides } : {}),
    ...(w.base ? { base: w.base } : {}),
  };
  return spec;
}

/** Throws what makes a process file unreadable as one. */
export function checkSpec(spec: ProcessSpec): void {
  if (!spec || typeof spec !== "object") throw new Error("A process is an object");
  if (typeof spec.id !== "string" || !NAME.test(spec.id)) throw new Error(`id "${spec.id}": lower case letters, digits and dashes`);
  if (typeof spec.label !== "string" || !spec.label.trim()) throw new Error("label: the process needs a name");
  if (!spec.nodes || typeof spec.nodes !== "object" || Array.isArray(spec.nodes)) throw new Error("nodes: an object of nodes");
  for (const [name, node] of Object.entries(spec.nodes)) {
    if (!NAME.test(name)) throw new Error(`Node "${name}": lower case letters, digits and dashes`);
    if (typeof node === "string") continue;
    if (!node || typeof node !== "object") throw new Error(`Node ${name}: a step id or an object`);
    if (!node.step === !node.process) throw new Error(`Node ${name}: either a step or a process`);
  }
  if (!Array.isArray(spec.edges)) throw new Error("edges: a list of [from, to]");
  for (const edge of spec.edges) {
    if (!Array.isArray(edge) || typeof edge[0] !== "string") throw new Error("Each edge is [from, to]");
    const to = edge[1];
    if (typeof to === "string") continue;
    if (isSwitch(to)) {
      if (typeof to.on !== "string" || !to.cases || typeof to.cases !== "object") throw new Error(`Edge from ${edge[0]}: { on, cases, else }`);
      continue;
    }
    if (!to || typeof to !== "object") throw new Error(`Edge from ${edge[0]}: a node or { on, cases }`);
  }
}

function checkAnswer(request: UserRequest, answer: unknown): void {
  if (request.kind === "choice") {
    if (!request.options.some((o) => o.id === answer)) {
      throw new UserError(`Answer one of ${request.options.map((o) => o.id).join(", ")}`);
    }
    return;
  }
  if (!answer || typeof answer !== "object") throw new UserError("Answer the form with an object of field values");
  for (const field of request.fields) {
    const value = (answer as Record<string, unknown>)[field.id];
    const list = field.options && field.multiple;
    if (list) {
      if (value !== undefined && !(Array.isArray(value) && value.every((v) => typeof v === "string"))) {
        throw new UserError(`${field.label}: expected a list of options`);
      }
    } else if (value !== undefined && typeof value !== "string") throw new UserError(`${field.label}: expected text`);
    const picked = (list ? ((value as string[] | undefined) ?? []) : [value as string | undefined]).filter((v) => v?.trim());
    if (field.required && !picked.length) throw new UserError(`${field.label} is required`);
    const stranger = field.options && !field.other && picked.find((v) => !field.options!.includes(v!));
    if (stranger) throw new UserError(`${field.label}: ${stranger} is not one of ${field.options!.join(", ")}`);
  }
}

/** Checks the folder setting `taskProcesses`: a list of `FolderProcess`, each process once. */
export function checkFolderProcesses(value: unknown): string | undefined {
  if (!Array.isArray(value)) return "expected a list of processes";
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object" || typeof item.process !== "string" || !item.process) {
      return 'each entry needs a "process" id';
    }
    if (seen.has(item.process)) return `${item.process} is listed twice`;
    seen.add(item.process);
    for (const key of ["icon", "hotkey"] as const) {
      if (item[key] !== undefined && typeof item[key] !== "string") return `${item.process}: "${key}" must be text`;
    }
    const extra = Object.keys(item).filter((k) => !["process", "icon", "hotkey"].includes(k));
    if (extra.length) return `${item.process}: unknown ${extra.join(", ")}`;
  }
  return undefined;
}
