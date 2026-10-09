// Finds plugins in plugins/<id>/, gives each a context and records what it writes (rule 7).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Db } from "./db.ts";
import type { EventBus } from "./events.ts";
import type { Sessions } from "./sessions.ts";
import type { Settings } from "./settings.ts";
import type { Processes } from "./processes.ts";
import type { Automations } from "./automations.ts";
import type { Store } from "./store.ts";
import type { PluginContext, ServerPlugin } from "../sdk/server.ts";
import type { AppInfo, AuditEntry, PluginInfo } from "../sdk/types.ts";

export interface Manifest {
  name?: string;
  description?: string;
  /** Permission id → why the plugin needs it. */
  permissions?: Record<string, string>;
  /** Set to false to switch the plugin off without deleting it. */
  enabled?: boolean;
}

export interface LoadedPlugin {
  info: PluginInfo;
  rpc: Map<string, (input: any) => unknown>;
}

interface Deps {
  app: AppInfo;
  db: Db;
  events: EventBus;
  store: Store;
  sessions: Sessions;
  settings: Settings;
  processes: Processes;
  automations: Automations;
}

export class Plugins {
  readonly loaded = new Map<string, LoadedPlugin>();
  private deps: Deps;

  constructor(deps: Deps) {
    this.deps = deps;
  }

  /** Loads every enabled plugin in `dir`, in alphabetical order. */
  async loadDir(dir: string): Promise<void> {
    if (!existsSync(dir)) return;
    for (const id of readdirSync(dir).sort()) {
      const manifestFile = join(dir, id, "plugin.json");
      if (!existsSync(manifestFile)) continue;
      const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as Manifest;
      if (manifest.enabled === false) continue;
      const serverFile = join(dir, id, "server.ts");
      const plugin = existsSync(serverFile)
        ? ((await import(pathToFileURL(serverFile).href)).default as ServerPlugin)
        : undefined;
      await this.load(id, manifest, plugin);
    }
  }

  async load(id: string, manifest: Manifest, plugin?: ServerPlugin): Promise<LoadedPlugin> {
    const loaded: LoadedPlugin = {
      info: {
        id,
        name: manifest.name ?? id,
        description: manifest.description ?? "",
        permissions: Object.entries(manifest.permissions ?? {}).map(([pid, reason]) => ({ id: pid, reason })),
      },
      rpc: new Map(),
    };
    this.loaded.set(id, loaded);
    try {
      await plugin?.setup(this.context(id, new Set(Object.keys(manifest.permissions ?? {})), loaded));
    } catch (error) {
      console.error(`Plugin ${id} failed to start:`, error);
    }
    return loaded;
  }

  audit(limit = 200): AuditEntry[] {
    return (
      this.deps.db.prepare("SELECT * FROM audit ORDER BY at DESC LIMIT ?").all(limit) as Record<string, any>[]
    ).map((r) => ({ at: r.at, plugin: r.plugin, action: r.action, permission: r.permission, declared: !!r.declared }));
  }

  private context(id: string, declared: Set<string>, loaded: LoadedPlugin): PluginContext {
    const { app, db, events, store, sessions, settings, processes, automations } = this.deps;

    // Trust, but record: the write goes through, and an undeclared one raises an alarm.
    const write = <A extends unknown[], R>(permission: string, action: string, fn: (...args: A) => R) =>
      (...args: A): R => {
        const ok = declared.has(permission);
        db.prepare("INSERT INTO audit VALUES (?, ?, ?, ?, ?)").run(Date.now(), id, action, permission, ok ? 1 : 0);
        if (!ok) {
          console.warn(`Plugin ${id} used ${action} without declaring ${permission} in plugin.json`);
          events.emit("audit.alarm", { plugin: id, action, permission });
        }
        return fn(...args);
      };

    return {
      id,
      app,
      log: (...args) => console.log(`[${id}]`, ...args),
      events: {
        on: (name, handler) => events.on(name, handler),
        emit: (name, payload) => events.emit(`${id}.${name}`, payload),
      },
      statuses: {
        list: () => store.statuses(),
        register: write("statuses:register", "statuses.register", (defs) => store.registerStatuses(id, defs)),
      },
      folders: {
        list: () => store.folders(),
        get: (fid) => store.folder(fid),
        chain: (fid) => store.chain(fid),
        create: write("folders:write", "folders.create", (input) => store.createFolder(input)),
        update: write("folders:write", "folders.update", (fid, patch) => store.updateFolder(fid, patch)),
      },
      tasks: {
        list: (folderId, options) =>
          store.tasks(folderId, options?.archived === "all" ? "all" : options?.archived ? "archived" : "active"),
        get: (tid) => store.task(tid),
        create: write("tasks:write", "tasks.create", (input) => store.createTask(input)),
        update: write("tasks:write", "tasks.update", (tid, patch) => store.updateTask(tid, patch)),
        setStatus: write("tasks:write", "tasks.setStatus", (tid, status) => store.setStatus(tid, status)),
        guardTransition: write("tasks:guard", "tasks.guardTransition", (guard) => store.guardTransition(guard)),
        archive: write("tasks:write", "tasks.archive", (tid) => store.archiveTask(tid, id)),
        restore: write("tasks:write", "tasks.restore", (tid) => store.restoreTask(tid)),
        delete: write("tasks:write", "tasks.delete", (tid) => store.deleteTask(tid)),
      },
      agents: {
        sessions: (taskId) => sessions.list(taskId),
        providers: () => sessions.providerInfo(),
        registerProvider: write("agents:provide", "agents.registerProvider", (provider) =>
          sessions.registerProvider(id, provider),
        ),
        start: write("agents:spawn", "agents.start", (taskId, options) => sessions.start(taskId, options)),
        send: write("agents:spawn", "agents.send", (sessionId, text) => sessions.send(sessionId, text)),
        run: write("agents:spawn", "agents.run", (prompt, options) => sessions.run(prompt, options)),
        stop: write("agents:spawn", "agents.stop", (sessionId, reason) => sessions.kill(sessionId, reason)),
        continuation: (sessionId) => sessions.continuation(sessionId),
        continue: write("agents:spawn", "agents.continue", (sessionId) => sessions.continue(sessionId)),
        screen: (sessionId) => sessions.screen(sessionId),
        log: (sessionId) => sessions.log(sessionId),
        onSignal: (signal) => sessions.registerSignal(id, signal),
      },
      steps: {
        list: () => processes.stepInfo(),
        register: write("steps:register", "steps.register", (step) => processes.registerStep(id, step)),
        remove: write("steps:register", "steps.remove", (stepId) => processes.removeStep(id, stepId)),
      },
      processes: {
        list: () => processes.list(),
        run: (taskId) => processes.run(taskId),
        register: write("processes:register", "processes.register", (def) => processes.register(id, def)),
        start: write("processes:run", "processes.start", (taskId, processId, input) =>
          processes.start(taskId, processId, input),
        ),
        resume: write("processes:run", "processes.resume", (taskId, answer) => processes.resume(taskId, answer)),
        trace: (taskId) => processes.trace(taskId),
        versions: (processId) => processes.versions(processId),
        save: write("processes:register", "processes.save", (plugin, spec, note) => processes.save(plugin, spec, note)),
        remove: write("processes:register", "processes.remove", (processId) => processes.remove(processId)),
        preview: (plugin, spec) => processes.preview(plugin, spec),
        upgrade: write("processes:run", "processes.upgrade", (taskId) => processes.upgrade(taskId)),
        createTask: write("processes:run", "processes.createTask", (input, processId, options) =>
          processes.createTask(input, processId, options?.input, options?.options, options?.spec),
        ),
      },
      automations: {
        list: () => automations.list(),
        runs: (automationId) => automations.runs(automationId),
      },
      workspaces: {
        registerResolver: write("workspaces:resolve", "workspaces.registerResolver", (resolver) =>
          sessions.registerResolver(resolver),
        ),
        registerRestorer: write("workspaces:resolve", "workspaces.registerRestorer", (restorer) =>
          sessions.registerRestorer(restorer),
        ),
        ofFolder: (taskId) => sessions.ofFolder(taskId),
      },
      rpc: {
        handle: (name, handler) => void loaded.rpc.set(name, handler),
      },
      settings: {
        define: (defs) => settings.define(id, defs),
        // A plugin may name its own settings without its prefix.
        get: <T,>(key: string, folderId?: string | null) =>
          settings.get<T>(settings.has(`${id}.${key}`) ? `${id}.${key}` : key, folderId),
      },
      kv: {
        get: <T,>(key: string) => {
          const row = db.prepare("SELECT value FROM plugin_kv WHERE plugin = ? AND key = ?").get(id, key) as
            | { value: string }
            | undefined;
          return row ? (JSON.parse(row.value) as T) : undefined;
        },
        set: (key, value) =>
          void db
            .prepare("INSERT INTO plugin_kv VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET value = excluded.value")
            .run(id, key, JSON.stringify(value)),
      },
    };
  }
}
