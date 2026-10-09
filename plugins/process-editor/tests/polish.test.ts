import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { definePlugin, type ProcessSpec } from "../../../src/sdk/server.ts";
import { createCore } from "../../../src/server/app.ts";
import { root, testCore } from "../../../test/helpers.ts";
import editor, { shareIssue } from "../server.ts";
import { recipe } from "../model.ts";
import { layout } from "../schema.ts";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

describe("the schema", () => {
  it("lays the development process out: down to the next, skips on the right, ways back on the left", async () => {
    const core = await testCore({ pluginsDir: join(root, "plugins") });
    const state = core.state();
    const def = state.processes.defs.find((w) => w.id === "dev-flow.dev")!;
    const rows = recipe(def, def.spec, state.processes.steps);
    const schema = layout(rows, (_row, part) => part.label);
    expect(schema.boxes).toHaveLength(11);
    const kinds = schema.edges.map((e) => `${e.from}>${e.to}:${e.kind}`);
    expect(kinds).toContain("describe>refine:down");
    expect(kinds).toContain("test>code:back");
    expect(kinds).toContain("manual>merge:skip");
    expect(kinds).toContain("merge>end:end");
    expect(kinds).toContain("test-dev>end:end");
    // Every box below the one before it, and the end below them all.
    expect(schema.boxes.every((b, i) => i === 0 || b.y > schema.boxes[i - 1].y)).toBe(true);
    expect(schema.end.y).toBeGreaterThan(schema.boxes.at(-1)!.y);
  });
});

describe("habits", () => {
  it("offers not to ask after the same answer again and again, unless told never", async () => {
    const core = await testCore();
    await core.plugins.load("steps", { permissions: { "steps:register": "", "processes:register": "" } }, definePlugin((ctx) => {
      ctx.steps.register({
        id: "ask",
        label: "Ask",
        run: ({ ask }) => void ask({ kind: "choice", title: "Ship?", options: [{ id: "ship", label: "Ship" }, { id: "no", label: "No" }] }),
      });
      ctx.processes.register({ id: "w", label: "W", nodes: { ask: "ask" }, edges: [["start", "ask"], ["ask", "end"]] });
    }));
    const loaded = await core.plugins.load("process-editor", { permissions: {} }, editor);
    const call = <T,>(name: string, input: unknown) => loaded.rpc.get(name)!(input) as T;
    core.settings.set("process-editor.habitAnswers", 3);
    const folder = core.store.createFolder({ name: "F" });
    const answer = async (value: string) => {
      const task = core.processes.createTask({ folderId: folder.id, title: "T" }, "steps.w");
      await core.processes.settled(task.id);
      core.processes.resume(task.id, value);
      await core.processes.settled(task.id);
    };
    const habit = () => call<{ answer: string; count: number } | null>("habit", { process: "steps.w", node: "ask", question: "main" });
    await answer("ship");
    await answer("ship");
    expect(habit()).toBeNull();
    await answer("ship");
    expect(habit()).toMatchObject({ answer: "ship", count: 3 });
    await answer("no");
    expect(habit()).toBeNull();
    for (const _ of [1, 2, 3]) await answer("no");
    call("habitNever", { process: "steps.w", node: "ask", question: "main" });
    expect(habit()).toBeNull();
  });
});

describe("sharing and updates", () => {
  it("writes the issue that offers a process", () => {
    const { title, body } = shareIssue(
      { id: "my-processes.notes", label: "Notes", plugin: "my-processes", description: "Quick notes", spec: { id: "notes", label: "Notes", nodes: {}, edges: [] } } as never,
      "for ideas",
    );
    expect(title).toBe("Process: “Notes”");
    expect(body).toContain("In their words: for ideas");
    expect(body).toContain("plugins/my-processes/processes/notes.json");
    expect(body).toContain('"label": "Notes"');
  });

  it("says when the original changed after the user's version was made from it", async () => {
    const base = mkdtempSync(join(tmpdir(), "agent-updates-"));
    cleanups.push(() => rmSync(base, { recursive: true, force: true }));
    const pluginsDir = join(base, "plugins");
    const spec: ProcessSpec = { id: "w", label: "W", nodes: {}, edges: [["start", "end"]] };
    mkdirSync(join(pluginsDir, "flows", "processes"), { recursive: true });
    writeFileSync(join(pluginsDir, "flows", "plugin.json"), "{}");
    writeFileSync(join(pluginsDir, "flows", "processes", "w.json"), JSON.stringify(spec));
    const core = await createCore({ root, dataDir: join(base, "data"), pluginsDir });
    cleanups.unshift(() => core.close());
    core.processes.loadFiles(pluginsDir, ["flows"]);
    const original = core.processes.get("flows.w")!.version!;
    core.processes.save("my-processes", { ...spec, id: "flows-w", label: "Mine", overrides: "flows.w", base: original });
    expect(core.processes.get("flows.w")?.original?.updated).toBe(false);
    // The plugin's file changes: an update.
    writeFileSync(join(pluginsDir, "flows", "processes", "w.json"), JSON.stringify({ ...spec, description: "new" }));
    core.processes.reloadFiles();
    expect(core.processes.get("flows.w")).toMatchObject({ label: "Mine", original: { updated: true } });
  });
});
