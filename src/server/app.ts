// Wires the core together. The HTTP layer and the tests both start from here.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { serverCodeHash } from "./code.ts";
import { openDb } from "./db.ts";
import { EventBus } from "./events.ts";
import { Plugins } from "./plugins.ts";
import { Restart } from "./restart.ts";
import { Sessions } from "./sessions.ts";
import { renamePluginFiles, renameSettingsFile } from "./renameProcess.ts";
import { Settings, type SettingsSources } from "./settings.ts";
import { defaultLogFilter } from "./logFilter.ts";
import { Store } from "./store.ts";
import { SqliteSaver } from "./checkpoints.ts";
import { checkFolderProcesses, Processes } from "./processes.ts";
import { Archive, ARCHIVE_AFTER, archiveAfterOptions, DELETE_AFTER, deleteAfterOptions } from "./archive.ts";
import { Automations } from "./automations.ts";
import type { AppInfo, AppState } from "../sdk/types.ts";

export interface AppOptions {
  /** The app's source directory. */
  root: string;
  dataDir: string;
  /** Defaults to <root>/plugins. */
  pluginsDir?: string;
  /** Shorthand for `--set defaultProvider=<id>`. */
  defaultProvider?: string;
  /** Defaults to <dataDir>/settings.json, no environment, no --set. */
  settings?: Partial<SettingsSources>;
  /** Stops this server so that it starts again; given by the entry point when something will start it again. */
  restart?: () => void;
}

export type Core = Awaited<ReturnType<typeof createCore>>;

export async function createCore(options: AppOptions) {
  mkdirSync(options.dataDir, { recursive: true });
  const settingsFile = options.settings?.file ?? join(options.dataDir, "settings.json");
  renameSettingsFile(settingsFile);
  const pkg = JSON.parse(readFileSync(join(options.root, "package.json"), "utf8"));
  const app: AppInfo = { name: pkg.name, version: pkg.version, root: options.root, restartable: !!options.restart };
  const db = openDb(join(options.dataDir, "agent.db"));
  const events = new EventBus();
  const store = new Store(db, events);
  const cli = { ...options.settings?.cli };
  if (options.defaultProvider) cli.defaultProvider ??= options.defaultProvider;
  const settings = new Settings(events, store, {
    file: settingsFile,
    env: options.settings?.env,
    cli,
  });
  const sessions = new Sessions(db, events, store, settings, options.dataDir);
  sessions.agentBin = join(options.root, "bin");
  const restart = new Restart(events, sessions, () => options.restart?.());
  settings.define("core", [
    {
      key: "defaultProvider",
      label: "Default agent",
      description: "The agent a task starts when none is picked.",
      type: "select",
      options: () => sessions.providerInfo().map((p) => ({ value: p.id, label: p.label })),
      default: "claude-code",
      folder: true,
    },
    {
      key: "taskProcesses",
      label: "Task buttons",
      description:
        "The processes a folder creates its tasks with most often: one button and hotkey each, in this order. Any other process is in the folder's menu.",
      type: "json",
      default: [],
      folder: true,
      validate: checkFolderProcesses,
    },
    {
      key: ARCHIVE_AFTER,
      label: "Archive done tasks",
      description: "A done task leaves the tree for the archive after this many days. Off: only by hand.",
      type: "select",
      options: archiveAfterOptions.map((value) => ({
        value,
        label: value === "off" ? "Off" : value === "0" ? "At once" : `After ${value} days`,
      })),
      default: "off",
      folder: true,
    },
    {
      key: DELETE_AFTER,
      label: "Delete from the archive",
      description: "An archived task is deleted for good after this many days in the archive. Off: only by hand.",
      type: "select",
      options: deleteAfterOptions.map((value) => ({ value, label: value === "off" ? "Off" : `After ${value} days` })),
      default: "off",
      folder: true,
    },
    {
      key: "logFilter",
      label: "Hidden log lines",
      description: "The desktop window leaves out its output lines that contain any of these strings.",
      type: "json",
      default: defaultLogFilter,
    },
    {
      key: "terminalPool",
      label: "Open terminals",
      description:
        "How many agent terminals the window keeps open, so going back to a task shows them at once. The least recently used one closes first; its agent keeps running.",
      type: "number",
      default: 5,
    },
  ]);
  const pluginsDir = options.pluginsDir ?? join(options.root, "plugins");
  renamePluginFiles(pluginsDir);
  // Before the plugins load, so a plugin edited while loading counts as changed.
  const code = serverCodeHash(options.root, pluginsDir);
  /** The server-side code on disk differs from the code this process loaded: a restart picks it up. */
  const codeChanged = () => serverCodeHash(options.root, pluginsDir) !== code;
  const processes = new Processes(db, events, store, new SqliteSaver(db), settings);
  const archive = new Archive(store, settings, events);
  const automations = new Automations(db, events, store, processes, sessions, archive);
  const plugins = new Plugins({ app, db, events, store, sessions, settings, processes, automations });
  await plugins.loadDir(pluginsDir);
  // Processes as files, after the steps they are made of.
  processes.loadFiles(pluginsDir, [...plugins.loaded.keys()]);
  // After the plugins, whose processes the automations' tasks follow.
  archive.start();
  automations.start();
  for (const key of Object.keys(cli)) {
    if (!settings.has(key)) console.warn(`--set ${key}: no such setting; the core and the plugins define ${settings.defs().map((d) => d.key).join(", ")}`);
  }

  const state = (): AppState => ({
    app,
    folders: store.folders(),
    tasks: store.tasks(),
    statuses: store.statuses(),
    providers: sessions.providerInfo(),
    sessions: sessions.list(),
    plugins: [...plugins.loaded.values()].map((p) => p.info),
    signals: sessions.signalInfo(),
    settings: { defs: settings.defs(), values: settings.values(), file: settings.path },
    processes: { defs: processes.list(), steps: processes.stepInfo(), runs: processes.runs() },
    archive: archive.info(),
    automations: automations.list(),
    restart: restart.pending ? { pending: true } : null,
  });

  const close = () => {
    // Plugins stop their timers and the processes they started.
    events.emit("app.stopping");
    archive.stop();
    automations.stop();
    restart.cancel();
    sessions.stopAll();
    processes.close();
    db.close();
  };

  return { app, db, events, store, settings, sessions, processes, archive, automations, plugins, restart, state, codeChanged, close };
}
