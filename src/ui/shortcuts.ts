// Keyboard shortcuts. Plugins declare them in defineUiPlugin({ shortcuts }); one listener dispatches them.
import type { Folder, Task } from "../sdk/types.ts";

/** What a shortcut acts on: the tree row in focus, else the open task. */
export type ShortcutTarget = { kind: "task"; task: Task } | { kind: "folder"; folder: Folder } | { kind: "none" };

interface ShortcutBase {
  /** "F2", "Delete", "Mod+K", "Shift+Alt+N"; several for alternatives. Mod is Cmd on macOS, Ctrl elsewhere. */
  keys: string | string[];
  /** Also fires while typing in a field or the terminal. Off by default. */
  inInputs?: boolean;
  /** What it does, e.g. "rename" or "delete": menu items with the same command show its keys. */
  command?: string;
}

export type Shortcut = ShortcutBase &
  (
    | { scope: "task"; run: (task: Task) => void }
    | { scope: "folder"; run: (folder: Folder) => void }
    | { scope?: "global"; run: () => void }
  );

/** The parts of a KeyboardEvent shortcuts look at. */
export interface KeyPress {
  key: string;
  /** The physical key, "KeyN" or "Digit1": with Alt on macOS, `key` is a symbol such as "˜". */
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

const aliases: Record<string, string> = { del: "delete", esc: "escape", space: " ", return: "enter" };

export function matches(combo: string, press: KeyPress, mac: boolean): boolean {
  const parts = combo.split("+").map((p) => p.trim().toLowerCase());
  const key = parts.pop()!;
  const mods = new Set(parts.map((m) => (m === "mod" ? (mac ? "meta" : "ctrl") : m === "cmd" ? "meta" : m)));
  const wanted = aliases[key] ?? key;
  const physical = /^(Key|Digit)(.)$/.exec(press.code ?? "")?.[2].toLowerCase();
  return (
    (press.key.toLowerCase() === wanted || physical === wanted) &&
    press.ctrlKey === mods.has("ctrl") &&
    press.metaKey === mods.has("meta") &&
    press.altKey === mods.has("alt") &&
    press.shiftKey === mods.has("shift")
  );
}

const macKeys: Record<string, string> = {
  mod: "⌘",
  cmd: "⌘",
  meta: "⌘",
  ctrl: "⌃",
  alt: "⌥",
  shift: "⇧",
  backspace: "⌫",
  delete: "⌦",
  enter: "↩",
  escape: "⎋",
};
const pcKeys: Record<string, string> = { mod: "Ctrl", cmd: "Win", meta: "Win", delete: "Del", escape: "Esc" };

/** How a combination is written in the interface: "Ctrl+Backspace", or "⌘⌫" on macOS. */
export function formatKeys(combo: string, mac: boolean): string {
  const parts = combo.split("+").map((p) => p.trim());
  const names = mac ? macKeys : pcKeys;
  const shown = parts.map((p) => names[p.toLowerCase()] ?? (p.length === 1 ? p.toUpperCase() : p));
  return shown.join(mac ? "" : "+");
}

/** A combination as separate key caps for a button's hint: ["Ctrl", "↵"], or ["⌘", "↩"] on macOS. */
export function keyCaps(combo: string, mac: boolean): string[] {
  return combo.split("+").map((p) => (!mac && /^enter$/i.test(p.trim()) ? "↵" : formatKeys(p, mac)));
}

/** The keys to show next to a menu item: the first shortcut for this command and scope. */
export function hintFor(
  shortcuts: Shortcut[],
  command: string,
  scope: NonNullable<Shortcut["scope"]>,
  mac: boolean,
): string | undefined {
  const shortcut = shortcuts.find((s) => s.command === command && (s.scope ?? "global") === scope);
  if (!shortcut) return undefined;
  const keys = Array.isArray(shortcut.keys) ? shortcut.keys : [shortcut.keys];
  // Mac keyboards have no Delete key: prefer a combination they can type.
  const key = (mac && keys.find((k) => !/^(del|delete)$/i.test(k.trim()))) || keys[0];
  return key && formatKeys(key, mac);
}

export const isMac = /mac|iphone|ipad/i.test(globalThis.navigator?.platform ?? "");

// slots.tsx, which loads the plugins, hands their shortcuts over here; plugins import this through #sdk/ui.
let enabled: () => Shortcut[] = () => [];
export function setShortcutSource(source: () => Shortcut[]): void {
  enabled = source;
}

/** The shortcuts of enabled plugins, which take their keys before a folder's process hotkeys do. */
export function enabledShortcuts(): Shortcut[] {
  return enabled();
}

/**
 * The combination a key press makes, as shortcuts write it: "Alt+N", "Mod+Shift+K", "F2".
 * Undefined while only modifiers are down.
 */
export function comboOf(press: KeyPress, mac: boolean): string | undefined {
  if (["Control", "Meta", "Alt", "Shift", "AltGraph", "CapsLock"].includes(press.key)) return undefined;
  const physical = /^(Key|Digit)(.)$/.exec(press.code ?? "")?.[2];
  const key = physical ?? (press.key === " " ? "Space" : press.key.length === 1 ? press.key.toUpperCase() : press.key);
  const mods = [
    (mac ? press.metaKey : press.ctrlKey) && "Mod",
    mac && press.ctrlKey && "Ctrl",
    !mac && press.metaKey && "Meta",
    press.altKey && "Alt",
    press.shiftKey && "Shift",
  ].filter(Boolean);
  return [...mods, key].join("+");
}

/** Keys of the enabled shortcut for a command, for a menu item: `<MenuItem shortcut={shortcutHint("rename", "task")}>`. */
export function shortcutHint(command: string, scope: NonNullable<Shortcut["scope"]>): string | undefined {
  return hintFor(enabled(), command, scope, isMac);
}

/** The first shortcut for this key press that applies to the target. */
export function findShortcut(
  shortcuts: Shortcut[],
  press: KeyPress,
  target: ShortcutTarget,
  { mac = false, inInput = false } = {},
): (() => void) | undefined {
  for (const s of shortcuts) {
    if (inInput && !s.inInputs) continue;
    if (!(Array.isArray(s.keys) ? s.keys : [s.keys]).some((k) => matches(k, press, mac))) continue;
    if (s.scope === "task" && target.kind === "task") return () => s.run(target.task);
    if (s.scope === "folder" && target.kind === "folder") return () => s.run(target.folder);
    if (!s.scope || s.scope === "global") return () => (s.run as () => void)();
  }
}
