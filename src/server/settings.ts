// Settings of the app and, for those that allow it, of folders. An app value comes from, strongest first:
// the command line (--set key=value), the environment (PITWALL_<KEY>), the settings file, the default.
// A folder value overrides the app value for the folder and its subfolders.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { EventBus } from "./events.ts";
import { UserError, type Store } from "./store.ts";
import type { SettingInput } from "../sdk/server.ts";
import type { Folder, SettingDef, SettingSource, SettingValue } from "../sdk/types.ts";

export interface SettingsSources {
  /** JSON file with an object of key → value. Written when the user changes an app setting. */
  file: string;
  /** Usually process.env. */
  env?: Record<string, string | undefined>;
  /** Raw `--set key=value` pairs. */
  cli?: Record<string, string>;
}

/** Keys the environment uses for the app itself; settings cannot take them. */
const reservedEnv = new Set(["PITWALL_DATA_DIR", "PITWALL_TOKEN", "PITWALL_URL", "PITWALL_SETTINGS"]);

/** `defaultProvider` → PITWALL_DEFAULT_PROVIDER, `dev-flow.targetBranch` → PITWALL_DEV_FLOW_TARGET_BRANCH. */
export function envName(key: string): string {
  return "PITWALL_" + key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[^A-Za-z0-9]+/g, "_").toUpperCase();
}

type Def = Omit<SettingDef, "options" | "env"> & Pick<SettingInput, "options" | "validate">;

export class Settings {
  private defsByKey = new Map<string, Def>();
  private sources: SettingsSources;
  private events: EventBus;
  private store: Store;
  private cache: { mtime: number; values: Record<string, unknown> } | undefined;

  constructor(events: EventBus, store: Store, sources: SettingsSources) {
    this.events = events;
    this.store = store;
    this.sources = sources;
  }

  /** `plugin` is "core" or a plugin id; a plugin's keys get its id as a prefix. */
  define(plugin: string, defs: SettingInput[]): void {
    for (const def of defs) {
      const key = plugin === "core" ? def.key : `${plugin}.${def.key}`;
      if (reservedEnv.has(envName(key))) throw new Error(`Setting ${key} would clash with ${envName(key)}`);
      this.defsByKey.set(key, { ...def, key, plugin });
    }
    this.events.emit("settings.defined", { plugin, keys: defs.map((d) => d.key) });
  }

  has(key: string): boolean {
    return this.defsByKey.has(key);
  }

  defs(): SettingDef[] {
    return [...this.defsByKey.values()].map(({ validate: _, ...d }) => ({
      ...d,
      options: typeof d.options === "function" ? d.options() : d.options,
      env: envName(d.key),
    }));
  }

  /** The settings file's path. */
  get path(): string {
    return this.sources.file;
  }

  /** Every app value with where it came from. */
  values(): Record<string, SettingValue> {
    return Object.fromEntries([...this.defsByKey.keys()].map((key) => [key, this.app(key)]));
  }

  app(key: string): SettingValue {
    const def = this.def(key);
    const cli = this.sources.cli?.[key];
    if (cli !== undefined) return { value: parse(def, cli, "--set"), source: "cli" };
    // An empty variable counts as unset, as `PITWALL_X= pnpm start` means to clear it.
    const env = this.sources.env?.[envName(key)];
    if (env !== undefined && env !== "") return { value: parse(def, env, envName(key)), source: "env" };
    const file = this.file();
    if (key in file) return { value: file[key], source: "file" };
    return { value: def.default, source: "default" };
  }

  /** The value for a task in this folder: the nearest folder that sets it, else the app value. */
  get<T = unknown>(key: string, folderId?: string | null): T {
    const def = this.def(key);
    if (def.folder && folderId) {
      for (const folder of this.store.chain(folderId)) {
        if (key in folder.settings) return folder.settings[key] as T;
      }
    }
    return this.app(key).value as T;
  }

  /** Where a folder's value comes from, for showing what it inherits. */
  inherited(key: string, folderId: string): { value: unknown; from: Folder | SettingSource } {
    const [, ...ancestors] = this.store.chain(folderId);
    for (const folder of ancestors) if (key in folder.settings) return { value: folder.settings[key], from: folder };
    const app = this.app(key);
    return { value: app.value, from: app.source };
  }

  /** Writes an app value to the settings file; null goes back to the default. */
  set(key: string, value: unknown): void {
    const def = this.def(key);
    const current = this.app(key);
    if (current.source === "cli" || current.source === "env") {
      const where = current.source === "cli" ? `--set ${key}=…` : envName(key);
      throw new UserError(`${def.label} is set by ${where} and cannot be changed here`);
    }
    const file = { ...this.file() };
    if (value === null || value === undefined) delete file[key];
    else file[key] = check(def, value);
    mkdirSync(dirname(this.sources.file), { recursive: true });
    writeFileSync(this.sources.file, JSON.stringify(file, null, 2) + "\n");
    this.cache = undefined;
    this.events.emit("settings.changed", { key, value: this.app(key).value });
  }

  /** Throws why a folder cannot take this value, so a new folder can be checked before it is made. */
  checkFolder(key: string, value: unknown): void {
    const def = this.def(key);
    if (!def.folder) throw new UserError(`${def.label} is an app setting, folders cannot change it`);
    if (value !== null && value !== undefined) check(def, value);
  }

  /** Sets a folder's own value; null makes it inherit again. */
  setFolder(folderId: string, key: string, value: unknown): Folder {
    const def = this.def(key);
    this.checkFolder(key, value);
    const folder = this.store.updateFolder(folderId, {
      settings: { [key]: value === null || value === undefined ? null : check(def, value) },
    });
    this.events.emit("settings.changed", { key, folderId, value: folder.settings[key] ?? null });
    return folder;
  }

  private def(key: string): Def {
    const def = this.defsByKey.get(key);
    if (!def) throw new UserError(`No setting ${key}`);
    return def;
  }

  /** The file, read again when it changed on disk: people edit it by hand too. */
  private file(): Record<string, unknown> {
    const { file } = this.sources;
    if (!existsSync(file)) return {};
    const mtime = statSync(file).mtimeMs;
    if (this.cache?.mtime === mtime) return this.cache.values;
    let values: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) values = parsed;
      else console.warn(`${file} is not a JSON object; ignoring it`);
    } catch (error) {
      console.warn(`Cannot read ${file}: ${(error as Error).message}`);
    }
    this.cache = { mtime, values };
    return values;
  }
}

/** A value from the command line or the environment, which are strings, turned into the setting's type. */
function parse(def: Def, raw: string, where: string): unknown {
  switch (def.type) {
    case "boolean":
      if (/^(1|true|yes|on)$/i.test(raw)) return true;
      if (/^(0|false|no|off|)$/i.test(raw)) return false;
      throw new Error(`${where}: ${def.key} must be true or false, got "${raw}"`);
    case "number": {
      const n = Number(raw);
      if (raw.trim() === "" || Number.isNaN(n)) throw new Error(`${where}: ${def.key} must be a number, got "${raw}"`);
      return n;
    }
    case "json":
      try {
        return JSON.parse(raw);
      } catch {
        throw new Error(`${where}: ${def.key} must be JSON`);
      }
    default:
      return raw;
  }
}

/** A value from the UI or a plugin, checked against the setting's type. */
function check(def: Def, value: unknown): unknown {
  const ok =
    def.type === "boolean"
      ? typeof value === "boolean"
      : def.type === "number"
        ? typeof value === "number" && Number.isFinite(value)
        : def.type === "json"
          ? true
          : typeof value === "string";
  if (!ok) throw new UserError(`${def.label}: expected a ${def.type === "select" ? "string" : def.type}`);
  const wrong = def.validate?.(value);
  if (wrong) throw new UserError(`${def.label}: ${wrong}`);
  return value;
}
