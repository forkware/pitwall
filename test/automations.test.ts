import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { definePlugin } from "../src/sdk/server.ts";
import type { Core } from "../src/server/app.ts";
import { parseFilter, render } from "../src/server/automations.ts";
import { nextRun, nextRuns, parseCron } from "../src/server/cron.ts";
import { startHttp } from "../src/server/http.ts";
import { DAY } from "../src/server/archive.ts";
import { testCore, waitFor } from "./helpers.ts";

const utc = (s: string) => Date.parse(`${s}Z`);

describe("cron", () => {
  it("finds the next runs in a time zone", () => {
    const weekdays = parseCron("0 3 * * 1-5");
    // Friday 2026-10-09 10:00 UTC → Monday 03:00 in Moscow (UTC+3) is 00:00 UTC.
    expect(new Date(nextRun(weekdays, utc("2026-10-09T10:00:00"), "Europe/Moscow")!).toISOString()).toBe("2026-10-12T00:00:00.000Z");
    expect(nextRuns(parseCron("*/15 * * * *"), utc("2026-10-09T10:07:00"), "UTC", 3).map((t) => new Date(t).toISOString())).toEqual([
      "2026-10-09T10:15:00.000Z",
      "2026-10-09T10:30:00.000Z",
      "2026-10-09T10:45:00.000Z",
    ]);
    expect(new Date(nextRun(parseCron("30 9 1 jan *"), utc("2026-10-09T10:00:00"), "UTC")!).toISOString()).toBe("2027-01-01T09:30:00.000Z");
    // Day of month or day of week, as in cron: the 13th, or any Friday.
    expect(new Date(nextRun(parseCron("0 0 13 * 5"), utc("2026-10-10T00:00:00"), "UTC")!).toISOString()).toBe("2026-10-13T00:00:00.000Z");
  });

  it("says what is wrong with an expression", () => {
    expect(() => parseCron("0 3 * *")).toThrow(/five fields/);
    expect(() => parseCron("61 * * * *")).toThrow(/minute: "61"/);
    expect(() => parseCron("0 0 30 feb *")).not.toThrow();
    expect(nextRun(parseCron("0 0 30 feb *"), Date.now(), "UTC")).toBeNull();
  });
});

describe("templates and filters", () => {
  it("fill in fields and report the missing ones", () => {
    const missing = new Set<string>();
    expect(render("{{payload.issue.title}} #{{payload.issue.number}}{{payload.nope}}", { payload: { issue: { title: "Bug", number: 42 } } }, missing)).toBe(
      "Bug #42",
    );
    expect([...missing]).toEqual(["payload.nope"]);
  });

  it("match payloads", () => {
    const f = parseFilter(`payload.action == "opened" && issue || force == true`);
    expect(f({ payload: { action: "opened", issue: {} } })).toBe(true);
    expect(f({ payload: { action: "closed", issue: {} } })).toBe(false);
    expect(f({ payload: { force: true } })).toBe(true);
    expect(parseFilter("number == 42")({ payload: { number: 42 } })).toBe(true);
    expect(parseFilter("action != 'opened'")({ payload: { action: "opened" } })).toBe(false);
    expect(() => parseFilter("action == opened")).toThrow(/quotes/);
  });
});

/** A plugin with a process whose first step asks for the task in a form, like dev-flow's. */
async function withFormFlow(core: Core) {
  await core.plugins.load(
    "flow",
    { permissions: { "steps:register": "t", "processes:register": "t" } },
    definePlugin((ctx) => {
      ctx.steps.register({
        id: "describe",
        label: "Describe",
        run: ({ ask, setTask }) => {
          const answer = ask<{ prompt: string }>({ kind: "form", title: "What?", fields: [{ id: "prompt", label: "What", required: true }] });
          setTask({ body: answer.prompt });
        },
      });
      ctx.processes.register({ id: "dev", label: "Dev", nodes: { describe: "describe" }, edges: [["start", "describe"], ["describe", "end"]] });
    }),
  );
}

const schedule = (cron = "0 3 * * *") => ({ kind: "schedule" as const, cron, timezone: "UTC", missed: "skip" as const });

describe("automations", () => {
  it("make a task with the process and answer its first form", async () => {
    const core = await testCore();
    await withFormFlow(core);
    const folder = core.store.createFolder({ name: "Site" });
    const a = core.automations.create({
      folderId: folder.id,
      name: "Nightly build",
      trigger: schedule(),
      process: "flow.dev",
      title: "{{automation}} {{date}}",
      body: "Build the site",
    });
    const run = await core.automations.fire(a.id, "manual");
    expect(run.result).toBe("created");
    const task = core.store.task(run.taskId!)!;
    expect(task.title).toMatch(/^Nightly build \d{4}-\d\d-\d\d$/);
    expect(task.meta.automation).toMatchObject({ id: a.id, runId: run.id, how: "manual" });
    await waitFor(() => core.processes.run(task.id)?.state === "done");
    expect(core.store.task(task.id)?.body).toBe("Build the site");
    // Done, and archived at once: the default for automations.
    await waitFor(() => !!core.store.task(task.id)?.archivedAt);
    expect(core.store.task(task.id)?.archivedBy).toBe(`automation:${a.id}`);
    expect(core.automations.runs(a.id)[0].task).toMatchObject({ archived: true, process: "done" });
  });

  it("answer the process's questions for the user, when their condition holds", async () => {
    const core = await testCore();
    let passes = true;
    await core.plugins.load(
      "flow",
      { permissions: { "steps:register": "t", "processes:register": "t" } },
      definePlugin((ctx) => {
        ctx.steps.register({ id: "test", label: "Test", writes: ["tests.passed"], run: () => ({ "tests.passed": passes }) });
        ctx.steps.register({
          id: "ship",
          label: "Ship?",
          writes: ["ship.answer"],
          run: ({ ask }) => ({ "ship.answer": ask({ kind: "choice", id: "main", title: "Ship?", options: [{ id: "ship", label: "Ship" }, { id: "no", label: "No" }] }) }),
        });
        ctx.processes.register({
          id: "w",
          label: "W",
          nodes: { test: "test", ship: "ship" },
          edges: [["start", "test"], ["test", "ship"], ["ship", "end"]],
        });
      }),
    );
    const folder = core.store.createFolder({ name: "F" });
    const a = core.automations.create({
      folderId: folder.id,
      name: "Night",
      trigger: schedule(),
      process: "flow.w",
      questions: { "ship:main": { answer: "ship", when: { key: "tests.passed", value: "true" } } },
      seen: ["ship:main"],
    });
    expect(core.automations.get(a.id)).toMatchObject({ questions: { "ship:main": { answer: "ship" } }, seen: ["ship:main"] });
    const first = await core.automations.fire(a.id, "manual");
    await waitFor(() => core.processes.run(first.taskId!)?.state === "done");
    expect(core.processes.trace(first.taskId!).at(-1)).toMatchObject({ node: "ship", answer: "ship" });

    passes = false;
    const second = await core.automations.fire(a.id, "manual");
    await waitFor(() => core.processes.run(second.taskId!)?.state === "waiting");
    expect(core.processes.run(second.taskId!)).toMatchObject({ node: "ship" });

    expect(() => core.automations.update(a.id, { questions: { x: { answer: "" } } })).toThrow(/an answer/);
  });

  it("skip a run while the last task is not done, unless started by hand", async () => {
    const core = await testCore();
    const folder = core.store.createFolder({ name: "A" });
    const a = core.automations.create({ folderId: folder.id, name: "A", trigger: schedule(), title: "Run" });
    expect((await core.automations.fire(a.id, "schedule")).result).toBe("created");
    const skipped = await core.automations.fire(a.id, "schedule");
    expect(skipped).toMatchObject({ result: "skipped", detail: "previous" });
    expect((await core.automations.fire(a.id, "manual")).result).toBe("created");
    core.automations.update(a.id, { enabled: false });
    expect(await core.automations.fire(a.id, "schedule")).toMatchObject({ result: "skipped", detail: "paused" });
  });

  it("fire when the schedule is due, and handle runs missed while the app was off", async () => {
    const core = await testCore();
    const folder = core.store.createFolder({ name: "A" });
    const a = core.automations.create({ folderId: folder.id, name: "A", trigger: schedule("*/5 * * * *"), title: "Run" });
    const db = core.db;
    db.prepare("UPDATE automations SET cursor = ? WHERE id = ?").run(Date.now() - 10 * 60_000, a.id);
    core.automations.tick();
    await waitFor(() => core.automations.runs(a.id).length === 1);
    expect(core.automations.runs(a.id)[0]).toMatchObject({ how: "schedule", result: "created" });

    db.prepare("UPDATE automations SET cursor = ? WHERE id = ?").run(Date.now() - 10 * 60_000, a.id);
    core.automations.start();
    expect(core.automations.runs(a.id)[0]).toMatchObject({ how: "missed", result: "skipped", detail: "app-off" });
    core.automations.update(a.id, { trigger: { ...schedule("*/5 * * * *"), missed: "once" } });
    db.prepare("UPDATE automations SET cursor = ? WHERE id = ?").run(Date.now() - 10 * 60_000, a.id);
    core.store.archiveTask(core.store.tasks()[0].id);
    core.automations.start();
    await waitFor(() => core.automations.runs(a.id)[0].result === "created");
    expect(core.automations.runs(a.id)[0].how).toBe("missed");
    expect(core.automations.list()[0].nextRun).toBeGreaterThan(Date.now());
  });

  it("refuse a bad config", async () => {
    const core = await testCore();
    const folder = core.store.createFolder({ name: "A" });
    expect(() => core.automations.create({ folderId: folder.id, name: "A", trigger: schedule("nope") })).toThrow(/five fields/);
    expect(() => core.automations.create({ folderId: folder.id, name: "A", trigger: { ...schedule(), timezone: "Mars/Base" } })).toThrow(/time zone/);
    expect(() => core.automations.create({ folderId: folder.id, name: "A", trigger: schedule(), process: "none.such" })).toThrow(/No process/);
    expect(() => core.automations.create({ folderId: folder.id, name: "A", trigger: { kind: "webhook", verify: "url", filter: "a ==" } })).toThrow(/Filter/);
  });

  it("keep only their last runs in the archive", async () => {
    const core = await testCore();
    const folder = core.store.createFolder({ name: "A" });
    const a = core.automations.create({ folderId: folder.id, name: "A", trigger: schedule(), title: "Run", keepRuns: 2, overlap: "always" });
    for (let i = 0; i < 4; i++) {
      const run = await core.automations.fire(a.id, "schedule");
      core.store.archiveTask(run.taskId!);
      await new Promise((r) => setTimeout(r, 3));
    }
    expect(core.archive.sweep().deleted).toBe(2);
    expect(core.store.tasks(undefined, "archived")).toHaveLength(2);
    expect(core.store.deletions().every((d) => d.rule === "runs")).toBe(true);
  });

  it("decide when their tasks leave the archive, over the folder's rule", async () => {
    const core = await testCore();
    const folder = core.store.createFolder({ name: "A" });
    const a = core.automations.create({ folderId: folder.id, name: "A", trigger: schedule(), title: "Run", deleteAfter: 3 });
    const run = await core.automations.fire(a.id, "manual");
    core.store.archiveTask(run.taskId!);
    expect(core.archive.sweep(Date.now() + 4 * DAY).deleted).toBe(1);
  });

  it("delete with the folder, leaving the tasks in the archive", async () => {
    const core = await testCore();
    const folder = core.store.createFolder({ name: "A" });
    const a = core.automations.create({ folderId: folder.id, name: "A", trigger: schedule(), title: "Run" });
    await core.automations.fire(a.id, "manual");
    core.store.deleteFolder(folder.id);
    expect(core.automations.list()).toEqual([]);
    expect(core.store.tasks(undefined, "archived")).toHaveLength(1);
  });
});

describe("webhooks", () => {
  async function serve() {
    const core = await testCore();
    const http = await startHttp(core, { host: "127.0.0.1", port: 0, token: "t", built: true });
    const post = async (path: string, body: string, headers: Record<string, string> = {}) => {
      const res = await fetch(`http://127.0.0.1:${http.port}${path}`, { method: "POST", body, headers: { "Content-Type": "application/json", ...headers } });
      return { status: res.status, json: await res.json() };
    };
    return { core, http, post };
  }

  it("make a task from a request with the secret in the address, and refuse others", async () => {
    const { core, http, post } = await serve();
    try {
      const folder = core.store.createFolder({ name: "A" });
      const a = core.automations.create({
        folderId: folder.id,
        name: "Issues",
        trigger: { kind: "webhook", verify: "url", filter: `action == "opened"` },
        title: "{{payload.issue.title}}",
        body: "{{payload.issue.body}}",
      });
      const payload = JSON.stringify({ action: "opened", issue: { title: "Login fails", body: "On Safari" } });
      const ok = await post(core.automations.get(a.id)!.hookPath, payload);
      expect(ok.status).toBe(200);
      const task = core.store.task(ok.json.taskId)!;
      expect([task.title, task.body]).toEqual(["Login fails", "On Safari"]);
      expect((task.meta.automation as any).payload.issue.title).toBe("Login fails");

      expect((await post(`/hooks/${a.id}/wrong`, payload)).status).toBe(403);
      expect((await post(`/hooks/${a.id}`, payload)).status).toBe(403);
      expect((await post(`/hooks/${a.id}`, payload)).status).toBe(403);
      expect(core.automations.get(a.id)?.rejecting).toBe(true);
      expect((await post(core.automations.get(a.id)!.hookPath, JSON.stringify({ action: "closed" }))).status).toBe(202);
      expect(core.automations.runs(a.id)[0]).toMatchObject({ result: "rejected", detail: "filter" });
      expect(core.automations.get(a.id)?.lastPayload).toEqual({ action: "closed" });

      core.automations.update(a.id, { enabled: false });
      expect((await post(core.automations.get(a.id)!.hookPath, payload)).status).toBe(503);
      expect((await post("/hooks/nope", payload)).status).toBe(404);
    } finally {
      await http.close();
    }
  });

  it("check GitHub's signature and a header", async () => {
    const { core, http, post } = await serve();
    try {
      const folder = core.store.createFolder({ name: "A" });
      const gh = core.automations.create({ folderId: folder.id, name: "GH", trigger: { kind: "webhook", verify: "github" }, title: "Push", overlap: "always" });
      const body = JSON.stringify({ ref: "main" });
      const sig = `sha256=${createHmac("sha256", gh.secret).update(body).digest("hex")}`;
      expect((await post(`/hooks/${gh.id}`, body, { "X-Hub-Signature-256": sig })).status).toBe(200);
      expect((await post(`/hooks/${gh.id}`, body, { "X-Hub-Signature-256": "sha256=00" })).status).toBe(403);

      const hd = core.automations.create({ folderId: folder.id, name: "H", trigger: { kind: "webhook", verify: "header" }, title: "Ping" });
      expect((await post(`/hooks/${hd.id}`, "{}", { "X-Pitwall-Token": hd.secret })).status).toBe(200);
      const renewed = core.automations.newSecret(hd.id);
      expect((await post(`/hooks/${hd.id}`, "{}", { "X-Pitwall-Token": hd.secret })).status).toBe(403);
      expect(renewed.secret).not.toBe(hd.secret);
    } finally {
      await http.close();
    }
  });

  it("log an empty title as an error", async () => {
    const { core, http, post } = await serve();
    try {
      const folder = core.store.createFolder({ name: "A" });
      const a = core.automations.create({ folderId: folder.id, name: "A", trigger: { kind: "webhook", verify: "url" }, title: "{{payload.title}}" });
      const res = await post(core.automations.get(a.id)!.hookPath, "{}");
      expect(res.status).toBe(500);
      expect(core.automations.runs(a.id)[0]).toMatchObject({ result: "error" });
      expect(core.automations.runs(a.id)[0].detail).toMatch(/payload.title/);
      expect(core.automations.get(a.id)?.failing).toBe(true);
    } finally {
      await http.close();
    }
  });
});
