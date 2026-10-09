import { describe, expect, it } from "vitest";
import { testCore } from "./helpers.ts";

describe("folders and tasks", () => {
  it("nests folders and deletes a subtree with its tasks", async () => {
    const { store } = await testCore();
    const root = store.createFolder({ name: "Work" });
    const child = store.createFolder({ name: "Client", parentId: root.id });
    store.createTask({ folderId: child.id, title: "Fix login" });
    expect(store.chain(child.id).map((f) => f.name)).toEqual(["Client", "Work"]);

    store.deleteFolder(root.id);
    expect(store.folders()).toEqual([]);
    expect(store.tasks()).toEqual([]);
  });

  it("refuses to move a folder into its own subtree", async () => {
    const { store } = await testCore();
    const a = store.createFolder({ name: "A" });
    const b = store.createFolder({ name: "B", parentId: a.id });
    expect(() => store.updateFolder(a.id, { parentId: b.id })).toThrow(/into itself/);
  });

  it("merges meta per plugin key", async () => {
    const { store } = await testCore();
    const folder = store.createFolder({ name: "A", meta: { one: 1 } });
    expect(store.updateFolder(folder.id, { meta: { two: 2 } }).meta).toEqual({ one: 1, two: 2 });
  });

  it("rejects empty names", async () => {
    const { store } = await testCore();
    expect(() => store.createFolder({ name: "  " })).toThrow(/empty/);
  });
});

describe("status model", () => {
  it("starts tasks as todo and emits status changes", async () => {
    const { store, events } = await testCore();
    const folder = store.createFolder({ name: "A" });
    const task = store.createTask({ folderId: folder.id, title: "T" });
    expect(task.status).toBe("todo");

    const changes: unknown[] = [];
    events.on("task.status.changed", ({ from, to }) => changes.push([from, to]));
    store.setStatus(task.id, "in_progress");
    expect(changes).toEqual([["todo", "in_progress"]]);
  });

  it("lets guards refuse a transition", async () => {
    const { store } = await testCore();
    store.registerStatuses("review-plugin", [{ id: "review", label: "Review", color: "amber", category: "active" }]);
    store.guardTransition((_t, from, to) => (to === "done" && from !== "review" ? "Review first" : true));
    const task = store.createTask({ folderId: store.createFolder({ name: "A" }).id, title: "T" });

    expect(() => store.setStatus(task.id, "done")).toThrow("Review first");
    store.setStatus(task.id, "review");
    expect(store.setStatus(task.id, "done").status).toBe("done");
  });

  it("rejects unknown statuses", async () => {
    const { store } = await testCore();
    const task = store.createTask({ folderId: store.createFolder({ name: "A" }).id, title: "T" });
    expect(() => store.setStatus(task.id, "nope")).toThrow(/Unknown status/);
  });
});
