import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, Folder, Task } from "../../../src/sdk/types.ts";
import { getState, setState } from "../../../src/ui/api.ts";
import { findShortcut, hintFor, type KeyPress, type ShortcutTarget } from "../../../src/ui/shortcuts.ts";

const { confirm } = vi.hoisted(() => ({ confirm: vi.fn() }));
vi.mock("../../../src/ui/kit/index.tsx", async (original) => ({ ...(await original<object>()), confirm }));

const { shortcuts } = await import("../ui.tsx");

const parent = { id: "f1", name: "Projects", parentId: null } as Folder;
const folder = { id: "f2", name: "App", parentId: "f1" } as Folder;
const task = { id: "t1", title: "Fix login", folderId: "f2" } as Task;

const press = (key: string, mods: Partial<KeyPress> = {}): KeyPress => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});
const fire = (key: string, target: ShortcutTarget, options = {}) => {
  const run = findShortcut(shortcuts, press(key), target, options);
  run?.();
  return !!run;
};

beforeEach(() => {
  confirm.mockReset();
  setState({
    data: { folders: [parent, folder], tasks: [task], sessions: [], processes: { runs: [] }, automations: [] } as unknown as AppState,
    collapsed: { f1: true, f2: true },
    renaming: null,
    picked: [],
  });
});

describe("hotkeys", () => {
  it("F2 renames the task in focus and unfolds its folders", () => {
    fire("F2", { kind: "task", task });
    expect(getState().renaming).toBe("t1");
    expect(getState().collapsed).toEqual({});
  });

  it("F2 renames the folder in focus", () => {
    fire("F2", { kind: "folder", folder });
    expect(getState().renaming).toBe("f2");
    expect(getState().collapsed).toEqual({ f2: true });
  });

  it("Delete sends the task to the archive at once, with Undo", async () => {
    const fetch = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetch);
    fire("Delete", { kind: "task", task });
    expect(confirm).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/tasks/archive", expect.objectContaining({ method: "POST" })));
    expect(JSON.parse((fetch.mock.calls[0] as any)[1].body)).toEqual({ ids: ["t1"] });
    await new Promise((r) => setTimeout(r, 0));
    fire("z", { kind: "none" }, {});
    findShortcut(shortcuts, press("z", { ctrlKey: true }), { kind: "none" })!();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/tasks/restore", expect.objectContaining({ method: "POST" })));
    vi.unstubAllGlobals();
  });

  it("Delete acts on all picked tasks when the target is one of them", async () => {
    const other = { id: "t2", title: "Other", folderId: "f2" } as Task;
    const fetch = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetch);
    setState({ data: { folders: [parent, folder], tasks: [task, other], sessions: [], processes: { runs: [] } } as unknown as AppState, picked: ["t1", "t2"] });
    fire("Delete", { kind: "task", task });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(JSON.parse((fetch.mock.calls[0] as any)[1].body)).toEqual({ ids: ["t1", "t2"] });
    vi.unstubAllGlobals();
  });

  it("Shift+Delete deletes for good after asking; Delete on a folder asks first", async () => {
    const fetch = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetch);
    fire("Delete", { kind: "task", task }, {});
    fetch.mockClear();
    findShortcut(shortcuts, press("Delete", { shiftKey: true }), { kind: "task", task })!();
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm.mock.calls[0][0].title).toContain("Fix login");
    expect(fetch).not.toHaveBeenCalled();
    await confirm.mock.calls[0][0].onConfirm();
    expect(fetch).toHaveBeenCalledWith("/api/tasks/delete", expect.objectContaining({ method: "POST" }));

    // A folder with a task in it.
    findShortcut(shortcuts, press("Backspace", { metaKey: true }), { kind: "folder", folder }, { mac: true })!();
    expect(confirm).toHaveBeenCalledTimes(2);
    await confirm.mock.calls[1][0].onConfirm();
    expect(fetch).toHaveBeenCalledWith("/api/folders/f2", expect.objectContaining({ method: "DELETE" }));
    vi.unstubAllGlobals();
  });

  it("does nothing without a target or while typing", () => {
    expect(fire("F2", { kind: "none" })).toBe(false);
    expect(fire("Delete", { kind: "none" })).toBe(false);
    expect(fire("F2", { kind: "task", task }, { inInput: true })).toBe(false);
    expect(fire("Delete", { kind: "task", task }, { inInput: true })).toBe(false);
  });

  it("gives the menus their hints: F2 to rename, Del to archive, Shift+Del to delete", () => {
    for (const scope of ["task", "folder"] as const) expect(hintFor(shortcuts, "rename", scope, false)).toBe("F2");
    expect(hintFor(shortcuts, "archive", "task", false)).toBe("Del");
    expect(hintFor(shortcuts, "archive", "task", true)).toBe("⌘⌫");
    expect(hintFor(shortcuts, "deleteForever", "task", false)).toBe("Shift+Del");
    expect(hintFor(shortcuts, "delete", "folder", false)).toBe("Del");
  });
});
