import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fakeProvider, root, testCore, waitFor } from "../../../test/helpers.ts";
import { ftsQuery, metaText, parseQuery, type SearchInput, type SearchResult } from "../search.ts";
import plugin from "../server.ts";

async function setup() {
  const core = await testCore();
  const manifest = JSON.parse(readFileSync(join(root, "plugins/search/plugin.json"), "utf8"));
  const loaded = await core.plugins.load("search", manifest, plugin);
  const search = (input: SearchInput) => loaded.rpc.get("search")!(input) as SearchResult;
  const titles = (input: SearchInput) => search(input).hits.map((h) => h.task.title);
  return { core, search, titles };
}

describe("search", () => {
  it("finds tasks by the start of words in the title, body, plugin data and folder", async () => {
    const { core, search, titles } = await setup();
    const site = core.store.createFolder({ name: "Site" });
    const app = core.store.createFolder({ name: "App" });
    core.store.createTask({ folderId: app.id, title: "Голосовой ввод: фразы по паузам" });
    core.store.createTask({ folderId: app.id, title: "Login", body: "Fails on Safari when the cookie expires" });
    core.store.createTask({ folderId: site.id, title: "Deploy", meta: { "dev-flow": { spec: "Publish to Netlify", issue: 35 } } });

    expect(titles({ query: "голос" })).toEqual(["Голосовой ввод: фразы по паузам"]);
    expect(titles({ query: "safari" })).toEqual(["Login"]);
    expect(search({ query: "safari" }).hits[0].snippet).toContain("«Safari»");
    expect(titles({ query: "netlify" })).toEqual(["Deploy"]);
    expect(titles({ query: "#35" })).toEqual(["Deploy"]);
    expect(titles({ query: "site deploy" })).toEqual(["Deploy"]);
    expect(titles({ query: "nothing-like-this" })).toEqual([]);
  });

  it("leaves the archive out unless asked, and says how much it has", async () => {
    const { core, search, titles } = await setup();
    const folder = core.store.createFolder({ name: "A" });
    const old = core.store.createTask({ folderId: folder.id, title: "Old report" });
    core.store.createTask({ folderId: folder.id, title: "New report" });
    core.store.archiveTask(old.id);

    expect(titles({ query: "report" })).toEqual(["New report"]);
    expect(search({ query: "report" }).archived).toBe(1);
    expect(titles({ query: "report", archive: "archived" })).toEqual(["Old report"]);
    expect(titles({ query: "report", archive: "all" }).sort()).toEqual(["New report", "Old report"]);
    expect(titles({ query: "report is:archived" })).toEqual(["Old report"]);
    core.store.restoreTask(old.id);
    expect(search({ query: "report" }).archived).toBe(0);
  });

  it("filters by folder, status, source and date, from the page or as prefixes", async () => {
    const { core, titles } = await setup();
    const work = core.store.createFolder({ name: "Work" });
    const sub = core.store.createFolder({ name: "Client", parentId: work.id });
    const home = core.store.createFolder({ name: "Home" });
    const a = core.store.createTask({ folderId: sub.id, title: "Fix login" });
    core.store.createTask({ folderId: home.id, title: "Fix sink" });
    core.store.setStatus(a.id, "done");
    const auto = core.automations.create({ folderId: home.id, name: "Hook", trigger: { kind: "webhook", verify: "url" }, title: "Fix from hook" });
    await core.automations.fire(auto.id, "webhook", {});

    expect(titles({ query: "fix", folderId: work.id })).toEqual(["Fix login"]);
    expect(titles({ query: "fix in:work" })).toEqual(["Fix login"]);
    expect(titles({ query: "fix status:done" })).toEqual(["Fix login"]);
    expect(titles({ query: "fix is:open" }).sort()).toEqual(["Fix from hook", "Fix sink"]);
    expect(titles({ query: "fix from:webhook" })).toEqual(["Fix from hook"]);
    expect(titles({ query: "fix", source: "manual" }).sort()).toEqual(["Fix login", "Fix sink"]);
    expect(titles({ query: "fix", source: auto.id })).toEqual(["Fix from hook"]);
    expect(titles({ query: "fix updated:1" })).toHaveLength(3);
    // Filters alone list what matches, newest first.
    expect(titles({ status: "done" })).toEqual(["Fix login"]);
  });

  it("keeps the index up to date as tasks change", async () => {
    const { core, titles } = await setup();
    const folder = core.store.createFolder({ name: "A" });
    const task = core.store.createTask({ folderId: folder.id, title: "First name" });
    core.store.updateTask(task.id, { title: "Renamed thing" });
    expect(titles({ query: "first" })).toEqual([]);
    expect(titles({ query: "renamed" })).toEqual(["Renamed thing"]);
    core.store.updateFolder(folder.id, { name: "Projects" });
    expect(titles({ query: "projects" })).toEqual(["Renamed thing"]);
    core.store.deleteTask(task.id);
    expect(titles({ query: "renamed" })).toEqual([]);
  });

  it("searches what the agents printed only when asked", async () => {
    const { core, search } = await setup();
    core.sessions.registerProvider("test", fakeProvider("echo the quokka answered; sleep 30"));
    const task = core.store.createTask({ folderId: core.store.createFolder({ name: "A" }).id, title: "Chat" });
    const s = core.sessions.start(task.id, { provider: "fake" });
    await waitFor(() => core.sessions.log(s.id).includes("quokka"));
    expect(search({ query: "quokka" }).hits).toEqual([]);
    const hit = search({ query: "quokka", logs: true }).hits[0];
    expect(hit.task.title).toBe("Chat");
    expect(hit.snippet).toContain("«quokka»");
  });
});

describe("query parsing", () => {
  it("takes prefixes out and keeps the words", () => {
    expect(parseQuery('login in:"My app" is:waiting from:cron created:7d')).toEqual({
      words: "login",
      filters: { folderId: "name:My app", state: "waiting", source: "schedule", created: 7 },
    });
    expect(ftsQuery('fix "login"')).toBe('"fix"* AND "login"*');
    expect(ftsQuery("  ")).toBeNull();
    expect(metaText({ a: { b: ["x", 2] }, c: null })).toBe("x 2");
  });
});
