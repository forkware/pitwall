import { describe, expect, it } from "vitest";
import type { AppState, Automation, Folder, Task } from "../src/sdk/types.ts";
import { folderSections, isGone, successor } from "../src/ui/tree.ts";

const folder = (id: string, parentId: string | null = null) => ({ id, parentId, name: id }) as Folder;
const task = (id: string, folderId: string, status = "done", meta: Record<string, unknown> = {}) =>
  ({ id, folderId, title: id, status, meta }) as unknown as Task;

function data(folders: Folder[], tasks: Task[], automations: Automation[] = []) {
  return {
    folders,
    tasks,
    automations,
    statuses: [
      { id: "todo", category: "todo" },
      { id: "done", category: "done" },
    ],
    processes: { defs: [], steps: [], runs: [] },
    sessions: [],
  } as unknown as AppState;
}

// A folder whose Done section holds d1..d3, with an open task above them.
const folders = [folder("f"), folder("g"), folder("f.sub", "f")];
const tasks = [task("open", "f", "todo"), task("d1", "f"), task("d2", "f"), task("d3", "f"), task("other", "g")];
const state = data(folders, tasks);

/** Archives the task the way Del does over and over: what is selected next, until nothing is. */
function delInARow(from: string): (string | null)[] {
  let s = state;
  let at: string | null = from;
  const seen: (string | null)[] = [];
  while (at && s.tasks.some((x) => x.id === at)) {
    const next = successor(s, at, new Set([at]));
    s = { ...s, tasks: s.tasks.filter((x) => x.id !== at) };
    at = next?.kind === "task" ? next.id : null;
    seen.push(next ? `${next.kind}:${next.id}` : null);
  }
  return seen;
}

describe("where the selection goes when rows leave the tree", () => {
  it("Del in a row in Done archives the tasks one by one, then lands on the folder", () => {
    expect(delInARow("d1")).toEqual(["task:d2", "task:d3", "folder:f"]);
  });

  it("takes the task above when the last one of the section goes, and never jumps to another section", () => {
    expect(successor(state, "d3", new Set(["d3"]))).toEqual({ kind: "task", id: "d2" });
    expect(successor(state, "open", new Set(["open"]))).toEqual({ kind: "folder", id: "f" });
  });

  it("skips the other tasks that go along, as when picked tasks are archived together", () => {
    expect(successor(state, "d1", new Set(["d1", "d2"]))).toEqual({ kind: "task", id: "d3" });
    expect(successor(state, "d2", new Set(["d1", "d2", "d3"]))).toEqual({ kind: "folder", id: "f" });
  });

  it("goes from a deleted folder to the folder beside it, or to its parent", () => {
    expect(successor(state, "f", new Set(["f"]))).toEqual({ kind: "folder", id: "g" });
    expect(successor(state, "g", new Set(["g"]))).toEqual({ kind: "folder", id: "f" });
    expect(successor(state, "f.sub", new Set(["f.sub"]))).toEqual({ kind: "folder", id: "f" });
    expect(successor(state, "f", new Set(["f", "g"]))).toBeNull();
  });

  it("goes from a task of a deleted folder to the folder beside it", () => {
    expect(isGone(state, "d1", new Set(["f"]))).toBe(true);
    expect(isGone(state, "other", new Set(["f"]))).toBe(false);
    expect(successor(state, "d1", new Set(["f"]))).toEqual({ kind: "folder", id: "g" });
  });

  it("keeps an automation's tasks in their own section", () => {
    const a = { id: "a", folderId: "f", view: "group" } as Automation;
    const byA = { automation: { id: "a" } };
    const s = data(folders, [task("d1", "f"), task("auto1", "f", "done", byA), task("auto2", "f", "done", byA)], [a]);
    expect(folderSections(s.tasks, new Set(["done"]), [a], new Set()).groups[0].tasks.map((x) => x.id)).toEqual(["auto1", "auto2"]);
    expect(successor(s, "d1", new Set(["d1"]))).toEqual({ kind: "folder", id: "f" });
    expect(successor(s, "auto2", new Set(["auto2"]))).toEqual({ kind: "task", id: "auto1" });
  });
});
