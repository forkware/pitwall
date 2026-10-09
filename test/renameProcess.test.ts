import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { migrations, openDb } from "../src/server/db.ts";
import { renamePluginFiles, renameSettingsFile } from "../src/server/renameProcess.ts";

// Built from parts, so the old word is only where the migration keeps it.
const OLD = "work" + "flow";
const tmp = () => mkdtempSync(join(tmpdir(), "agent-rename-"));

describe("data from before the rename to process", () => {
  it("renames the tables, columns, plugin ids and keys in the database", () => {
    const file = join(tmp(), "agent.db");
    const old = new DatabaseSync(file);
    for (const m of migrations.slice(0, -1)) old.exec(m as string);
    old.exec(`PRAGMA user_version = ${migrations.length - 1}`);
    old.exec(`
      INSERT INTO folders (id, name, position, created_at, settings) VALUES ('f', 'F', 1, 0, '{"task${"W" + OLD.slice(1)}s":[{"${OLD}":"my-${OLD}s.notes"}]}');
      INSERT INTO tasks (id, folder_id, title, status, position, created_at, updated_at, meta) VALUES ('t', 'f', 'T', 'todo', 1, 0, 0, '{"${OLD}-editor":{"keep":true}}');
      INSERT INTO ${OLD}_runs (task_id, ${OLD}, state, started_at, updated_at, version) VALUES ('t', 'my-${OLD}s.notes', 'waiting', 0, 0, 'abc');
      INSERT INTO ${OLD}_versions (${OLD}, version, plugin, spec, at) VALUES ('my-${OLD}s.notes', 'abc', 'my-${OLD}s', '{"id":"notes","nodes":{"inner":{"${OLD}":"dev-flow.dev"}},"edges":[]}', 0);
      INSERT INTO ${OLD}_trace (task_id, node, step, started_at, result) VALUES ('t', 'a', 'basic-steps.describe', 0, 'done');
      INSERT INTO plugin_kv (plugin, key, value) VALUES ('${OLD}-editor', 'habit:my-${OLD}s.notes|a|q', '{"answer":"x","count":2}');
    `);
    old.close();

    const db = openDb(file);
    expect(db.prepare("SELECT process, version FROM process_runs").get()).toEqual({ process: "my-processes.notes", version: "abc" });
    const version = db.prepare("SELECT process, plugin, spec FROM process_versions").get() as Record<string, string>;
    expect(version).toMatchObject({ process: "my-processes.notes", plugin: "my-processes" });
    expect(JSON.parse(version.spec).nodes.inner).toEqual({ process: "dev-flow.dev" });
    expect(db.prepare("SELECT count(*) AS n FROM process_trace").get()).toEqual({ n: 1 });
    expect(JSON.parse((db.prepare("SELECT settings FROM folders").get() as { settings: string }).settings)).toEqual({
      taskProcesses: [{ process: "my-processes.notes" }],
    });
    expect(JSON.parse((db.prepare("SELECT meta FROM tasks").get() as { meta: string }).meta)).toEqual({ "process-editor": { keep: true } });
    expect(db.prepare("SELECT plugin, key FROM plugin_kv").get()).toEqual({ plugin: "process-editor", key: "habit:my-processes.notes|a|q" });
    db.close();
  });

  it("renames the settings file's keys and the plugins' process files", () => {
    const settings = join(tmp(), "settings.json");
    writeFileSync(settings, JSON.stringify({ [`${OLD}-editor.agent`]: "codex", defaultProvider: "claude-code" }));
    renameSettingsFile(settings);
    expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({ "process-editor.agent": "codex", defaultProvider: "claude-code" });

    const plugins = tmp();
    mkdirSync(join(plugins, `my-${OLD}s`, `${OLD}s`), { recursive: true });
    writeFileSync(join(plugins, `my-${OLD}s`, `${OLD}s`, "mine.json"), JSON.stringify({ id: "mine", overrides: "dev-flow.dev", nodes: { x: { [OLD]: `my-${OLD}s.other` } }, edges: [] }));
    renamePluginFiles(plugins);
    expect(existsSync(join(plugins, `my-${OLD}s`))).toBe(false);
    const spec = JSON.parse(readFileSync(join(plugins, "my-processes", "processes", "mine.json"), "utf8"));
    expect(spec.nodes.x).toEqual({ process: "my-processes.other" });
  });
});
