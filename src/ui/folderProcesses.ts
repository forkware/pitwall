// The processes a folder creates its tasks with: its buttons, their hotkeys, and what a new folder starts with.
import type { AppState, Folder, FolderProcess, ProcessInfo } from "../sdk/types.ts";
import type { Shortcut } from "./shortcuts.ts";

export const SETTING = "taskProcesses";
/** How many buttons a folder's row shows; the rest are in its menu. */
export const MAX_BUTTONS = 5;
export const FALLBACK_ICON = "workflow";

/** A folder's process with the icon and hotkey it ends up with. */
export interface ResolvedProcess {
  process: string;
  /** Undefined when its plugin is gone: the button stays, disabled, so the folder's choice is not lost. */
  def?: ProcessInfo;
  label: string;
  icon: string;
  /** "" when it has none. */
  hotkey: string;
  /** Whether the icon and hotkey are the folder's own rather than the process's defaults. */
  ownIcon: boolean;
  ownHotkey: boolean;
}

/** The hotkey a process gets when neither it nor the folder names one: Alt and its place, up to 9. */
export function defaultHotkey(def: ProcessInfo | undefined, index: number): string {
  return def?.hotkey ?? (index < 9 ? `Alt+${index + 1}` : "");
}

export function resolve(list: FolderProcess[], defs: ProcessInfo[]): ResolvedProcess[] {
  return list.map((entry, i) => {
    const def = defs.find((d) => d.id === entry.process);
    return {
      process: entry.process,
      def,
      label: def?.label ?? entry.process,
      icon: entry.icon || def?.icon || FALLBACK_ICON,
      hotkey: entry.hotkey ?? defaultHotkey(def, i),
      ownIcon: !!entry.icon,
      ownHotkey: entry.hotkey !== undefined,
    };
  });
}

/** A folder's own list, or the one it inherits: the nearest folder that sets one, else the app's. */
export function folderList(data: AppState | null | undefined, folderId: string | null): FolderProcess[] {
  for (let f = findFolder(data, folderId); f; f = findFolder(data, f.parentId)) {
    if (SETTING in f.settings) return asList(f.settings[SETTING]);
  }
  return asList(data?.settings.values[SETTING]?.value);
}

export function folderProcesses(data: AppState | null | undefined, folderId: string | null): ResolvedProcess[] {
  return resolve(folderList(data, folderId), data?.processes.defs ?? []);
}

/**
 * What the new-folder dialog starts with. A subfolder: what it would inherit from its parent.
 * A top folder: the choice of the folder made last, so a user who always picks the same keeps it;
 * with no folder to copy, every process there is, and the app's agent.
 */
export function newFolderDefaults(
  data: AppState | null | undefined,
  parentId: string | null,
): { processes: FolderProcess[]; provider: string } {
  const inherited = inheritedValues(data, parentId);
  if (parentId) return inherited;
  const latest = (key: string) =>
    [...(data?.folders ?? [])].sort((a, b) => b.createdAt - a.createdAt).find((f) => key in f.settings);
  const fromProcesses = latest(SETTING);
  const fromProvider = latest("defaultProvider");
  const all = (data?.processes.defs ?? []).filter((d) => d.problems.length === 0).map((d) => ({ process: d.id }));
  return {
    processes: fromProcesses
      ? asList(fromProcesses.settings[SETTING])
      : inherited.processes.length
        ? inherited.processes
        : all,
    provider: fromProvider ? String(fromProvider.settings.defaultProvider) : inherited.provider,
  };
}

/** What a folder in `parentId` gets without values of its own. */
export function inheritedValues(data: AppState | null | undefined, parentId: string | null) {
  let provider = data?.settings.values.defaultProvider?.value as string | undefined;
  for (let f = findFolder(data, parentId); f; f = findFolder(data, f.parentId)) {
    if ("defaultProvider" in f.settings) {
      provider = String(f.settings.defaultProvider);
      break;
    }
  }
  return { processes: folderList(data, parentId), provider: provider ?? "" };
}

/** The settings a new folder saves: only what differs from what it would inherit. */
export function newFolderSettings(
  data: AppState | null | undefined,
  parentId: string | null,
  chosen: { processes: FolderProcess[]; provider: string },
): Record<string, unknown> {
  const inherited = inheritedValues(data, parentId);
  const settings: Record<string, unknown> = {};
  if (JSON.stringify(chosen.processes) !== JSON.stringify(inherited.processes)) settings[SETTING] = chosen.processes;
  if (chosen.provider && chosen.provider !== inherited.provider) settings.defaultProvider = chosen.provider;
  return settings;
}

/** Normalised for comparing: "alt+1" and "Alt+1" are the same keys. */
const norm = (combo: string) =>
  combo
    .split("+")
    .map((p) => p.trim().toLowerCase())
    .sort()
    .join("+");

/**
 * Why a process's hotkey does not work, by its index: an earlier process of the list or another
 * shortcut of the app (F2, Del, ...) takes the same keys first.
 */
export function hotkeyConflicts(list: ResolvedProcess[], taken: Shortcut[]): Record<number, string> {
  const conflicts: Record<number, string> = {};
  list.forEach((w, i) => {
    if (!w.hotkey) return;
    const key = norm(w.hotkey);
    const other = taken.find((s) => (Array.isArray(s.keys) ? s.keys : [s.keys]).some((k) => norm(k) === key));
    if (other) conflicts[i] = other.command ?? other.keys.toString();
    else {
      const earlier = list.slice(0, i).find((x) => x.hotkey && norm(x.hotkey) === key);
      if (earlier) conflicts[i] = earlier.label;
    }
  });
  return conflicts;
}

/**
 * The hotkeys of the folder a shortcut acts on: the folder in focus, or the folder of the task in focus.
 * `create` makes the task.
 */
export function processShortcuts(
  data: AppState | null | undefined,
  folderId: string | null,
  create: (folderId: string, process: string) => void,
): Shortcut[] {
  if (!folderId) return [];
  return folderProcesses(data, folderId)
    .filter((w) => w.hotkey && w.def && w.def.problems.length === 0)
    .map((w) => ({ keys: w.hotkey, run: () => create(folderId, w.process) }));
}

function findFolder(data: AppState | null | undefined, id: string | null): Folder | undefined {
  return id ? data?.folders.find((f) => f.id === id) : undefined;
}

function asList(value: unknown): FolderProcess[] {
  return Array.isArray(value) ? value.filter((x) => x && typeof x.process === "string") : [];
}
