import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { root, testCore } from "../../../test/helpers.ts";
import { recipe, usesOf } from "../model.ts";

async function devFlow() {
  const core = await testCore({ pluginsDir: join(root, "plugins") });
  const state = core.state();
  const def = state.processes.defs.find((w) => w.id === "dev-flow.dev")!;
  return { core, state, def, rows: recipe(def, def.spec, state.processes.steps) };
}

describe("the recipe", () => {
  it("numbers the steps in order and groups them by the task's status", async () => {
    const { rows } = await devFlow();
    expect(rows.map((r) => `${r.n} ${r.node} ${r.status}${r.groupStart ? " *" : ""}`)).toEqual([
      "1 describe todo *",
      "2 refine in_progress *",
      "3 clarify in_progress",
      "4 workspace in_progress",
      "5 code in_progress",
      "6 wait in_progress",
      "7 test testing *",
      "8 manual review *",
      "9 stand review",
      "10 merge merging *",
      "11 test-dev merging",
    ]);
  });

  it("says where a step goes when not simply on: by its outcomes and answers, back marked", async () => {
    const { rows } = await devFlow();
    const next = (node: string) =>
      rows.find((r) => r.node === node)!.next.map((p) => `${p.otherwise ? "else" : (p.label ?? "")} ${p.end ? "end" : p.n}${p.back ? " back" : ""}`);
    expect(next("describe")).toEqual([]);
    expect(next("test")).toEqual(["passed 8", "else 5 back"]);
    expect(next("manual")).toEqual(["Start the dev server 9", "Ready to deploy 10", "else 5 back"]);
    expect(next("stand")).toEqual(["Start again 9 back", "Ready to deploy 10", "else 5 back"]);
    expect(next("merge")).toEqual(["merged 11", "a conflict 5 back", "else end"]);
    expect(next("test-dev")).toEqual(["passed end", "else 5 back"]);
    expect(rows.find((r) => r.node === "test")!.next[0]).toMatchObject({ key: "dev.passed", values: ["true"] });
  });

  it("knows who does each step: you where it always asks, the agent, the app", async () => {
    const { rows, def } = await devFlow();
    expect(Object.fromEntries(rows.map((r) => [r.node, r.info.role]))).toMatchObject({
      describe: "you",
      refine: "agent",
      clarify: "app",
      wait: "agent",
      test: "app",
      manual: "you",
      merge: "app",
    });
    expect(def.asks).toBe(3);
  });

  it("finds where a process is used", async () => {
    const { core } = await devFlow();
    const folder = core.store.createFolder({ name: "F" });
    core.settings.setFolder(folder.id, "taskProcesses", [{ process: "dev-flow.dev" }]);
    const task = core.store.createTask({ folderId: folder.id, title: "T" });
    core.processes.start(task.id, "dev-flow.dev");
    await core.processes.settled(task.id);
    const uses = usesOf(core.state(), "dev-flow.dev");
    expect(uses).toMatchObject({ folders: [folder.id], app: false, automations: [], processes: [] });
    expect(uses.running.map((r) => r.taskId)).toEqual([task.id]);
  });
});
