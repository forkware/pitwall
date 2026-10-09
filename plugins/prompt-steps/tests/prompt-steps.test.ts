import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { definePlugin, type PluginContext } from "../../../src/sdk/server.ts";
import { testCore } from "../../../test/helpers.ts";
import { insertedKeys, parseStep, pickOption, writeStep } from "../files.ts";
import { makePromptSteps } from "../server.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("step files", () => {
  it("reads and writes a step: its settings on top, the prompt below", () => {
    const step = parseStep("changelog", "---\nlabel: Write a changelog\nmode: answer  # once\noptions: ok, needs work\n---\nLook at {{dev.slug}} and {{task.title}}.\n");
    expect(step).toEqual({
      name: "changelog",
      label: "Write a changelog",
      description: "",
      mode: "answer",
      key: "changelog",
      options: ["ok", "needs work"],
      prompt: "Look at {{dev.slug}} and {{task.title}}.",
    });
    expect(parseStep("changelog", writeStep(step))).toEqual(step);
    expect(insertedKeys(step.prompt)).toEqual(["dev.slug"]);
    expect(pickOption("Needs work\nbecause…", step.options)).toBe("needs work");
    expect(() => parseStep("Bad Name", "x")).toThrow(/lower case/);
  });
});

describe("steps in words", () => {
  async function setup() {
    const dir = mkdtempSync(join(tmpdir(), "agent-prompt-steps-"));
    dirs.push(dir);
    const core = await testCore({ defaultProvider: "fake" });
    let steps!: ReturnType<typeof makePromptSteps>;
    await core.plugins.load(
      "prompt-steps",
      { permissions: { "steps:register": "", "agents:spawn": "", "agents:provide": "", "processes:register": "" } },
      definePlugin((ctx: PluginContext) => {
        ctx.agents.registerProvider({ id: "fake", label: "Fake", command: "sh", exec: ({ prompt }) => ["-c", 'printf "%s\\n%s" "needs work" "$1"', "x", prompt] });
        steps = makePromptSteps(ctx, dir);
      }),
    );
    return { core, steps, dir };
  }

  it("makes a step from words that an agent answers, and the process branches on its pick", async () => {
    const { core, steps, dir } = await setup();
    const id = steps.save({ label: "Review the text", description: "", mode: "answer", key: "review", options: ["ok", "needs work"], prompt: "Review {{task.title}}" });
    expect(id).toBe("prompt-steps.review-the-text");
    expect(existsSync(join(dir, "review-the-text.md"))).toBe(true);
    const info = core.processes.stepInfo().find((s) => s.id === id)!;
    expect(info).toMatchObject({ role: "agent", writes: ["review.text", "review.choice"], outcomes: { "review.choice": { ok: "ok", "needs work": "needs work" } } });

    const folder = core.store.createFolder({ name: "F" });
    await core.plugins.load(
      "flows",
      { permissions: { "processes:register": "" } },
      definePlugin((ctx) =>
        ctx.processes.register({
          id: "w",
          label: "W",
          nodes: { review: id },
          edges: [
            ["start", "review"],
            ["review", "end"],
          ],
        }),
      ),
    );
    const task = core.processes.createTask({ folderId: folder.id, title: "the draft" }, "flows.w");
    expect(await core.processes.settled(task.id)).toMatchObject({ state: "done" });
    expect(core.processes.trace(task.id)[0].output).toMatchObject({ "review.choice": "needs work" });
    expect(String(core.processes.trace(task.id)[0].output?.["review.text"])).toContain("Review the draft");
  });

  it("takes a step back when its file goes", async () => {
    const { core, steps, dir } = await setup();
    steps.save({ label: "Tmp", description: "", mode: "terminal", key: "", options: [], prompt: "x" });
    expect(core.processes.stepInfo().some((s) => s.id === "prompt-steps.tmp")).toBe(true);
    expect(readFileSync(join(dir, "tmp.md"), "utf8")).toContain("mode: terminal");
    rmSync(join(dir, "tmp.md"));
    steps.load();
    expect(core.processes.stepInfo().some((s) => s.id === "prompt-steps.tmp")).toBe(false);
  });

  it("holds the place of a step being made: the process says it cannot run yet", async () => {
    const { core } = await setup();
    const folder = core.store.createFolder({ name: "F" });
    const making = core.store.createTask({ folderId: folder.id, title: "Step for deploys" });
    await core.plugins.load(
      "flows",
      { permissions: { "processes:register": "" } },
      definePlugin((ctx) =>
        ctx.processes.register({
          id: "w",
          label: "W",
          nodes: { deploy: { step: "prompt-steps.pending", params: { task: making.id } } },
          edges: [
            ["start", "deploy"],
            ["deploy", "end"],
          ],
        }),
      ),
    );
    expect(core.processes.get("flows.w")?.issues).toEqual([
      { code: "blocked", node: "deploy", data: { why: "the step is being made in “Step for deploys”" }, message: "Node deploy: the step is being made in “Step for deploys”" },
    ]);
  });
});
