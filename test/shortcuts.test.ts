import { describe, expect, it, vi } from "vitest";
import type { Folder, Task } from "../src/sdk/types.ts";
import { findShortcut, formatKeys, keyCaps, matches, hintFor, type KeyPress, type Shortcut } from "../src/ui/shortcuts.ts";

const press = (key: string, mods: Partial<KeyPress> = {}): KeyPress => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});
const task = { id: "t1", title: "Task" } as Task;
const folder = { id: "f1", name: "Folder" } as Folder;

describe("shortcuts", () => {
  it("shows a form's send keys as caps: Ctrl and Enter, or Command on macOS", () => {
    expect(keyCaps("Mod+Enter", false)).toEqual(["Ctrl", "↵"]);
    expect(keyCaps("Mod+Enter", true)).toEqual(["⌘", "↩"]);
    expect(matches("Mod+Enter", press("Enter", { ctrlKey: true }), false)).toBe(true);
    expect(matches("Mod+Enter", press("Enter", { metaKey: true }), true)).toBe(true);
    expect(matches("Mod+Enter", press("Enter", { ctrlKey: true }), true)).toBe(false);
    expect(matches("Mod+Enter", press("Enter"), false)).toBe(false);
  });

  it("matches keys and exact modifiers, Mod per platform", () => {
    expect(matches("F2", press("F2"), false)).toBe(true);
    expect(matches("Del", press("Delete"), false)).toBe(true);
    expect(matches("F2", press("F2", { shiftKey: true }), false)).toBe(false);
    expect(matches("Mod+K", press("k", { ctrlKey: true }), false)).toBe(true);
    expect(matches("Mod+K", press("k", { metaKey: true }), true)).toBe(true);
    expect(matches("Mod+K", press("k", { ctrlKey: true }), true)).toBe(false);
    expect(matches("Shift+Alt+N", press("N", { shiftKey: true, altKey: true }), false)).toBe(true);
  });

  it("runs the first shortcut that fits the target's scope", () => {
    const onTask = vi.fn();
    const onFolder = vi.fn();
    const global = vi.fn();
    const list: Shortcut[] = [
      { keys: "F2", scope: "task", run: onTask },
      { keys: "F2", scope: "folder", run: onFolder },
      { keys: ["F2", "F3"], run: global },
    ];
    findShortcut(list, press("F2"), { kind: "folder", folder })!();
    expect(onFolder).toHaveBeenCalledWith(folder);
    findShortcut(list, press("F2"), { kind: "task", task })!();
    expect(onTask).toHaveBeenCalledWith(task);
    findShortcut(list, press("F2"), { kind: "none" })!();
    findShortcut(list, press("F3"), { kind: "task", task })!();
    expect(global).toHaveBeenCalledTimes(2);
    expect(findShortcut(list, press("F4"), { kind: "task", task })).toBeUndefined();
  });

  it("skips shortcuts in inputs unless they ask for it", () => {
    const run = vi.fn();
    expect(findShortcut([{ keys: "F2", run }], press("F2"), { kind: "none" }, { inInput: true })).toBeUndefined();
    expect(findShortcut([{ keys: "F2", run, inInputs: true }], press("F2"), { kind: "none" }, { inInput: true })).toBeDefined();
  });

  it("writes keys the platform's way", () => {
    expect(formatKeys("F2", false)).toBe("F2");
    expect(formatKeys("Delete", false)).toBe("Del");
    expect(formatKeys("Mod+Shift+k", false)).toBe("Ctrl+Shift+K");
    expect(formatKeys("Mod+Backspace", true)).toBe("⌘⌫");
    expect(formatKeys("Mod+Shift+k", true)).toBe("⌘⇧K");
  });

  it("hints the first shortcut for a command and scope; on a Mac, not the Delete key", () => {
    const run = () => {};
    const list: Shortcut[] = [
      { command: "delete", keys: ["Delete", "Mod+Backspace"], scope: "task", run },
      { command: "find", keys: "Mod+F", run },
    ];
    expect(hintFor(list, "delete", "task", false)).toBe("Del");
    expect(hintFor(list, "delete", "task", true)).toBe("⌘⌫");
    expect(hintFor(list, "delete", "folder", false)).toBeUndefined();
    expect(hintFor(list, "find", "global", false)).toBe("Ctrl+F");
  });
});
