import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState, Folder, Task } from "../src/sdk/types.ts";
import { getState, setState } from "../src/ui/api.ts";
import { adjacentRow, rowArrow, rowContextMenu, rowSelection, treeKeepsFocus } from "../src/ui/treeKeys.ts";

const folder = { id: "f1", name: "App", parentId: null } as Folder;
const open = { id: "t1", title: "Open", folderId: "f1", status: "todo" } as Task;
const done = { id: "t2", title: "Done", folderId: "f1", status: "done" } as Task;
const data = { folders: [folder], tasks: [open, done] } as unknown as AppState;

/** A tree row as the sidebar renders it: an element with data-tree-id inside the role="tree" list. */
function row(id: string, tree: { rows: ReturnType<typeof row>[] }) {
  const el = {
    dataset: { treeId: id } as DOMStringMap,
    focus: vi.fn(),
    closest: (selector: string) => (selector === '[role="tree"]' ? { querySelectorAll: () => tree.rows } : null),
  };
  return el;
}

function treeOf(...ids: string[]) {
  const tree = { rows: [] as ReturnType<typeof row>[] };
  tree.rows = ids.map((id) => row(id, tree));
  return tree.rows;
}

const key = (k: string, currentTarget: unknown, mods = {}) => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  currentTarget: currentTarget as HTMLElement,
  preventDefault: vi.fn(),
  ...mods,
});

beforeEach(() => setState({ data, selection: null }));

describe("tree keyboard", () => {
  it("steps to the row above or below, and stops at the ends", () => {
    const ids = ["f1", "t1", "t2"];
    expect(adjacentRow(ids, "t1", "ArrowDown")).toBe("t2");
    expect(adjacentRow(ids, "t1", "ArrowUp")).toBe("f1");
    expect(adjacentRow(ids, "t2", "ArrowDown")).toBeUndefined();
    expect(adjacentRow(ids, "f1", "ArrowUp")).toBeUndefined();
    expect(adjacentRow(ids, "t1", "ArrowLeft")).toBeUndefined();
  });

  it("knows what a row opens: a task, a folder or an automation", () => {
    expect(rowSelection("t2", data)).toEqual({ kind: "task", id: "t2" });
    expect(rowSelection("f1", data)).toEqual({ kind: "folder", id: "f1" });
    expect(rowSelection("automation:a1", data)).toEqual({ kind: "automation", id: "a1" });
    expect(rowSelection("gone", data)).toBeUndefined();
  });

  it("Down on a task focuses and opens the next row, a done task too", () => {
    const [f, t1, t2] = treeOf("f1", "t1", "t2");
    const e = key("ArrowDown", t1);
    expect(rowArrow(e)).toBe(true);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(t2.focus).toHaveBeenCalled();
    expect(getState().selection).toEqual({ kind: "task", id: "t2" });

    expect(rowArrow(key("ArrowUp", t1))).toBe(true);
    expect(f.focus).toHaveBeenCalled();
    expect(getState().selection).toEqual({ kind: "folder", id: "f1" });
  });

  it("leaves other keys and the arrows with modifiers alone", () => {
    const [, t1, t2] = treeOf("f1", "t1", "t2");
    expect(rowArrow(key("ArrowDown", t1, { shiftKey: true }))).toBe(false);
    expect(rowArrow(key("Delete", t1))).toBe(false);
    expect(t2.focus).not.toHaveBeenCalled();
    expect(getState().selection).toBeNull();
  });

  it("the row of the task it opened keeps the focus, so Del acts at once", () => {
    const [, t1] = treeOf("f1", "t1");
    const active = t1 as unknown as Element;
    expect(treeKeepsFocus(active, { kind: "task", id: "t1" })).toBe(true);
    // Another task opened, by a hotkey on the folder's row, say: its terminal and form take the focus.
    expect(treeKeepsFocus(active, { kind: "task", id: "t2" })).toBe(false);
    // A button inside a row, or nothing in focus.
    expect(treeKeepsFocus({ dataset: {} } as unknown as Element, { kind: "task", id: "t1" })).toBe(false);
    expect(treeKeepsFocus(null, { kind: "task", id: "t1" })).toBe(false);
  });
});

describe("tree context menu", () => {
  it("a right click opens the row's menu instead of the browser's", () => {
    const openMenu = vi.fn();
    const e = { target: { closest: () => null } as unknown as EventTarget, preventDefault: vi.fn() };
    rowContextMenu(e, openMenu);
    expect(openMenu).toHaveBeenCalledOnce();
    expect(e.preventDefault).toHaveBeenCalled();
  });

  it("a name being renamed keeps the browser's menu", () => {
    const openMenu = vi.fn();
    const input = {} as EventTarget;
    const e = { target: { closest: (s: string) => (s.includes("input") ? input : null) } as unknown as EventTarget, preventDefault: vi.fn() };
    rowContextMenu(e, openMenu);
    expect(openMenu).not.toHaveBeenCalled();
    expect(e.preventDefault).not.toHaveBeenCalled();
  });
});
