import { describe, expect, it } from "vitest";
import { startHttp } from "../src/server/http.ts";
import { DAY } from "../src/server/archive.ts";
import { fakeProvider, testCore, waitFor } from "./helpers.ts";

describe("the archive", () => {
  it("takes a task out of the tree with its status, and brings it back", async () => {
    const { store, events } = await testCore();
    const folder = store.createFolder({ name: "Work" });
    const task = store.createTask({ folderId: folder.id, title: "Fix login" });
    store.setStatus(task.id, "in_progress");
    const seen: string[] = [];
    events.on("task.archived", (t) => seen.push(`archived ${t.id}`));
    events.on("task.restored", (t) => seen.push(`restored ${t.id}`));

    const archived = store.archiveTask(task.id);
    expect(archived.archivedAt).toBeTypeOf("number");
    expect(archived.archivedBy).toBe("user");
    expect(store.tasks()).toEqual([]);
    expect(store.tasks(undefined, "archived").map((t) => t.id)).toEqual([task.id]);
    expect(store.task(task.id)?.status).toBe("in_progress");

    const back = store.restoreTask(task.id);
    expect(back.archivedAt).toBeNull();
    expect(store.tasks().map((t) => t.id)).toEqual([task.id]);
    expect(seen).toEqual([`archived ${task.id}`, `restored ${task.id}`]);
  });

  it("remembers when a task became done, and counts again from a restore", async () => {
    const { store } = await testCore();
    const task = store.createTask({ folderId: store.createFolder({ name: "A" }).id, title: "T" });
    expect(task.doneAt).toBeNull();
    const done = store.setStatus(task.id, "done");
    expect(done.doneAt).toBeTypeOf("number");
    expect(store.setStatus(task.id, "todo").doneAt).toBeNull();
    store.setStatus(task.id, "done");
    store.archiveTask(task.id);
    const before = store.task(task.id)!.doneAt!;
    await new Promise((r) => setTimeout(r, 5));
    expect(store.restoreTask(task.id).doneAt).toBeGreaterThan(before);
  });

  it("deleting a folder archives its tasks; restoring one brings the folder back with its settings", async () => {
    const { store, settings } = await testCore();
    const root = store.createFolder({ name: "Work" });
    const child = store.createFolder({ name: "Client", parentId: root.id });
    settings.setFolder(child.id, "defaultProvider", "codex");
    const task = store.createTask({ folderId: child.id, title: "Fix login" });

    store.deleteFolder(root.id);
    expect(store.folders()).toEqual([]);
    expect(store.tasks()).toEqual([]);
    const [archived] = store.tasks(undefined, "archived");
    expect(archived.archivedBy).toBe("folder");
    expect(store.path(archived.folderId)).toBe("Work / Client");

    store.restoreTask(task.id);
    expect(store.folders().map((f) => f.name)).toEqual(["Work", "Client"]);
    expect(store.folder(child.id)?.settings).toEqual({ defaultProvider: "codex" });
  });

  it("deletes an empty folder at once, and a deleted folder once its last task is gone", async () => {
    const { store, db } = await testCore();
    const empty = store.createFolder({ name: "Empty" });
    store.deleteFolder(empty.id);
    const count = () => (db.prepare("SELECT count(*) AS n FROM folders").get() as { n: number }).n;
    expect(count()).toBe(0);

    const folder = store.createFolder({ name: "Work" });
    const task = store.createTask({ folderId: folder.id, title: "T" });
    store.deleteFolder(folder.id);
    expect(count()).toBe(1);
    store.deleteTask(task.id);
    expect(count()).toBe(0);
  });

  it("ends an archived task's agents and does not start new ones", async () => {
    const core = await testCore();
    core.sessions.registerProvider("test", fakeProvider("sleep 30"));
    const task = core.store.createTask({ folderId: core.store.createFolder({ name: "A" }).id, title: "T" });
    const session = core.sessions.start(task.id, { provider: "fake" });
    core.store.archiveTask(task.id);
    await waitFor(() => core.sessions.get(session.id)?.state === "exited");
    expect(core.sessions.get(session.id)?.exitReason).toBe("archived");
    expect(() => core.sessions.start(task.id, { provider: "fake" })).toThrow(/archive/);
    expect(() => core.sessions.continue(session.id)).toThrow(/archive/);
  });
});

describe("the archive's rules", () => {
  it("are off by default", async () => {
    const { store, archive } = await testCore();
    const task = store.createTask({ folderId: store.createFolder({ name: "A" }).id, title: "T" });
    store.setStatus(task.id, "done");
    expect(archive.sweep(Date.now() + 1000 * DAY)).toEqual({ archived: 0, deleted: 0 });
  });

  it("archive done tasks after the folder's days, and delete them after the archive's days", async () => {
    const { store, settings, archive } = await testCore();
    const folder = store.createFolder({ name: "A" });
    const other = store.createFolder({ name: "B" });
    settings.set("archiveAfter", "3");
    settings.set("archiveDeleteAfter", "30");
    settings.setFolder(other.id, "archiveDeleteAfter", "off");
    const done = store.createTask({ folderId: folder.id, title: "Done" });
    const open = store.createTask({ folderId: folder.id, title: "Open" });
    const kept = store.createTask({ folderId: other.id, title: "Kept forever" });
    store.setStatus(done.id, "done");
    store.setStatus(kept.id, "done");
    const now = Date.now();

    expect(archive.info(now).archiveAt[done.id]).toBeGreaterThan(now + 2 * DAY);
    expect(archive.sweep(now + 2 * DAY).archived).toBe(0);
    expect(archive.sweep(now + 3 * DAY + 1000)).toEqual({ archived: 2, deleted: 0 });
    expect(store.task(done.id)?.archivedBy).toBe("rule");
    expect(store.task(open.id)?.archivedAt).toBeNull();

    const listed = archive.list();
    expect(listed.find((t) => t.id === done.id)?.deleteAt).toBeGreaterThan(now);
    expect(listed.find((t) => t.id === kept.id)?.deleteAt).toBeNull();

    expect(archive.sweep(Date.now() + 31 * DAY)).toEqual({ archived: 0, deleted: 1 });
    expect(store.task(done.id)).toBeUndefined();
    expect(store.task(kept.id)).toBeDefined();
    expect(store.deletions().map((d) => [d.title, d.folder, d.rule])).toEqual([["Done", "A", "days"]]);
  });

  it("never delete a task the user kept", async () => {
    const { store, settings, archive } = await testCore();
    settings.set("archiveDeleteAfter", "7");
    const task = store.createTask({ folderId: store.createFolder({ name: "A" }).id, title: "T" });
    store.archiveTask(task.id);
    store.setKeep(task.id, true);
    expect(archive.sweep(Date.now() + 100 * DAY).deleted).toBe(0);
  });

  it("preview what turning a rule on takes at once, and give those tasks a grace period", async () => {
    const { store, archive } = await testCore();
    const folder = store.createFolder({ name: "A" });
    const old = store.createTask({ folderId: folder.id, title: "Old" });
    store.archiveTask(old.id);
    // Archived 40 days ago.
    (store as any).db.prepare("UPDATE tasks SET archived_at = ? WHERE id = ?").run(Date.now() - 40 * DAY, old.id);
    const fresh = store.createTask({ folderId: folder.id, title: "Fresh" });
    store.archiveTask(fresh.id);

    expect(archive.preview("archiveDeleteAfter", "30", null).map((t) => t.title)).toEqual(["Old"]);
    expect(archive.preview("archiveDeleteAfter", "30", folder.id).map((t) => t.title)).toEqual(["Old"]);
    expect(archive.preview("archiveDeleteAfter", "off", null)).toEqual([]);

    expect(archive.hold("archiveDeleteAfter", "30", null, 7)).toBe(1);
    expect(archive.preview("archiveDeleteAfter", "30", null)).toEqual([]);
  });

  it("are served over HTTP, and archived tasks are read only there", async () => {
    const core = await testCore();
    const http = await startHttp(core, { host: "127.0.0.1", port: 0, token: "t", built: true });
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`http://127.0.0.1:${http.port}${path}`, {
        method,
        headers: { Authorization: "Bearer t", "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, json: await res.json() };
    };
    try {
      const folder = core.store.createFolder({ name: "A" });
      const a = core.store.createTask({ folderId: folder.id, title: "A" });
      const b = core.store.createTask({ folderId: folder.id, title: "B" });
      await call("POST", "/api/tasks/archive", { ids: [a.id, b.id] });
      expect((await call("GET", "/api/archive")).json.map((t: any) => t.title).sort()).toEqual(["A", "B"]);
      expect((await call("GET", "/api/state")).json.archive.count).toBe(2);
      const refused = await call("PATCH", `/api/tasks/${a.id}`, { title: "Renamed" });
      expect(refused.status).toBe(400);
      expect((await call("PATCH", `/api/tasks/${a.id}`, { keep: true })).json.keep).toBe(true);
      await call("POST", "/api/tasks/restore", { ids: [a.id] });
      await call("POST", "/api/tasks/delete", { ids: [b.id] });
      expect(core.store.tasks().map((t) => t.title)).toEqual(["A"]);
      expect(core.store.task(b.id)).toBeUndefined();
    } finally {
      await http.close();
    }
  });
});
