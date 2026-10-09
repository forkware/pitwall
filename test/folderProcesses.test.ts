import { describe, expect, it, vi } from "vitest";
import type { AppState, Folder, ProcessInfo } from "../src/sdk/types.ts";
import {
  folderProcesses,
  hotkeyConflicts,
  newFolderDefaults,
  newFolderSettings,
  processShortcuts,
} from "../src/ui/folderProcesses.ts";
import { comboOf, findShortcut, matches, type KeyPress } from "../src/ui/shortcuts.ts";

const def = (id: string, extra: Partial<ProcessInfo> = {}): ProcessInfo => ({
  id,
  label: id.toUpperCase(),
  plugin: "p",
  nodes: [],
  doneStatus: "done",
  problems: [],
  issues: [],
  source: "code",
  spec: { id, label: id, nodes: {}, edges: [] },
  editable: true,
  version: null,
  template: false,
  inputs: [],
  asks: 0,
  ...extra,
});

const folder = (id: string, parentId: string | null, createdAt: number, settings: Record<string, unknown> = {}) =>
  ({ id, parentId, name: id, createdAt, settings }) as Folder;

function state(folders: Folder[], app: { taskProcesses?: unknown; defaultProvider?: string } = {}): AppState {
  return {
    folders,
    processes: { defs: [def("bug", { icon: "bug", hotkey: "Alt+B" }), def("note"), def("broken", { problems: ["x"] })], steps: [], runs: [] },
    settings: {
      defs: [],
      file: "",
      values: {
        taskProcesses: { value: app.taskProcesses ?? [], source: "default" },
        defaultProvider: { value: app.defaultProvider ?? "claude-code", source: "default" },
      },
    },
  } as unknown as AppState;
}

const press = (key: string, mods: Partial<KeyPress> = {}): KeyPress => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe("folder processes", () => {
  it("gives each process the folder's icon and hotkey, else the process's, else Alt and its place", () => {
    const data = state([
      folder("a", null, 1, { taskProcesses: [{ process: "note" }, { process: "bug" }, { process: "gone", icon: "star", hotkey: "" }] }),
      folder("b", "a", 2),
    ]);
    const list = folderProcesses(data, "b");
    expect(list.map((w) => [w.process, w.label, w.icon, w.hotkey, !!w.def])).toEqual([
      ["note", "NOTE", "workflow", "Alt+1", true],
      ["bug", "BUG", "bug", "Alt+B", true],
      ["gone", "gone", "star", "", false],
    ]);
  });

  it("starts a new top folder with the last folder's choice, a subfolder with its parent's, the first with all", () => {
    const empty = state([]);
    expect(newFolderDefaults(empty, null)).toEqual({ processes: [{ process: "bug" }, { process: "note" }], provider: "claude-code" });

    const data = state([
      folder("old", null, 1, { taskProcesses: [{ process: "bug" }], defaultProvider: "codex" }),
      folder("new", null, 2, { taskProcesses: [{ process: "note", icon: "star" }] }),
      folder("sub", "old", 3),
    ]);
    expect(newFolderDefaults(data, null)).toEqual({ processes: [{ process: "note", icon: "star" }], provider: "codex" });
    expect(newFolderDefaults(data, "sub")).toEqual({ processes: [{ process: "bug" }], provider: "codex" });
  });

  it("saves only what a new folder would not inherit", () => {
    const data = state([folder("a", null, 1, { taskProcesses: [{ process: "bug" }], defaultProvider: "codex" })]);
    expect(newFolderSettings(data, "a", { processes: [{ process: "bug" }], provider: "codex" })).toEqual({});
    expect(newFolderSettings(data, "a", { processes: [], provider: "claude-code" })).toEqual({
      taskProcesses: [],
      defaultProvider: "claude-code",
    });
    expect(newFolderSettings(data, null, { processes: [{ process: "bug" }], provider: "claude-code" })).toEqual({
      taskProcesses: [{ process: "bug" }],
    });
  });

  it("finds hotkeys an earlier process or another shortcut takes first", () => {
    const data = state([
      folder("a", null, 1, {
        taskProcesses: [{ process: "bug", hotkey: "Alt+2" }, { process: "note" }, { process: "broken", hotkey: "F2" }],
      }),
    ]);
    const conflicts = hotkeyConflicts(folderProcesses(data, "a"), [{ keys: "F2", command: "rename", scope: "task", run: () => {} }]);
    expect(conflicts).toEqual({ 1: "BUG", 2: "rename" });
  });

  it("makes the hotkeys of the folder in focus, leaving out processes that cannot run", () => {
    const data = state([folder("a", null, 1, { taskProcesses: [{ process: "bug" }, { process: "note" }, { process: "broken" }] })]);
    const create = vi.fn();
    const shortcuts = processShortcuts(data, "a", create);
    expect(shortcuts.map((s) => s.keys)).toEqual(["Alt+B", "Alt+2"]);
    findShortcut(shortcuts, press("2", { altKey: true }), { kind: "none" })?.();
    expect(create).toHaveBeenCalledWith("a", "note");
    expect(processShortcuts(data, null, create)).toEqual([]);
  });
});

describe("hotkeys by physical key", () => {
  it("matches Alt+letter on a Mac and Ctrl+letter on another layout by the key's place", () => {
    expect(matches("Alt+N", press("˜", { altKey: true, code: "KeyN" }), true)).toBe(true);
    expect(matches("Mod+K", press("л", { ctrlKey: true, code: "KeyK" }), false)).toBe(true);
    expect(matches("Alt+2", press("™", { altKey: true, code: "Digit2" }), true)).toBe(true);
    expect(matches("Alt+N", press("n", { altKey: true, code: "KeyM" }), false)).toBe(true);
  });

  it("records the combination a key press makes", () => {
    expect(comboOf(press("˜", { altKey: true, code: "KeyN" }), true)).toBe("Alt+N");
    expect(comboOf(press("K", { ctrlKey: true, shiftKey: true, code: "KeyK" }), false)).toBe("Mod+Shift+K");
    expect(comboOf(press("F2", { code: "F2" }), false)).toBe("F2");
    expect(comboOf(press("Alt", { altKey: true, code: "AltLeft" }), false)).toBeUndefined();
  });
});
