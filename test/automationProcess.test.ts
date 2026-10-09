import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { conditions, fillsFirstForm, newQuestions, processQuestions, summary } from "../src/ui/components/AutomationProcess.tsx";
import { root, testCore } from "./helpers.ts";

async function devFlow() {
  const core = await testCore({ pluginsDir: join(root, "plugins") });
  const state = core.state();
  const def = state.processes.defs.find((w) => w.id === "dev-flow.dev")!;
  return { def, defs: state.processes.defs, steps: state.processes.steps };
}

describe("an automation's process", () => {
  it("lists the questions in the recipe's order, the first form first", async () => {
    const { def, defs, steps } = await devFlow();
    const asked = processQuestions(def, defs, steps);
    expect(asked.map((q) => [q.n, q.key, q.first])).toEqual([
      ["1", "describe:main", true],
      ["3", "clarify:main", false],
      ["6", "wait:main", false],
      ["7", "test:main", false],
      ["8", "manual:main", false],
      ["8", "manual:comment", false],
      ["9", "stand:main", false],
      ["9", "stand:failed", false],
      ["9", "stand:comment", false],
      ["10", "merge:main", false],
    ]);
  });

  it("says what the user will find, and what is new since they decided", async () => {
    const { def, defs, steps } = await devFlow();
    const asked = processQuestions(def, defs, steps);
    expect(fillsFirstForm(asked[0], {})).toBe(true); // its one field takes the description
    expect(summary(asked, {}, true)).toMatch(/step 8/);
    const answers = {
      "manual:main": { answer: "ready", when: { key: "dev.passed", value: "true" } },
      "stand:main": { answer: "ready" },
    };
    expect(summary(asked, answers, true)).toMatch(/now and then/);
    expect(summary(asked, answers, false)).toMatch(/first form/);
    expect(conditions(def, steps).map((c) => `${c.key}=${c.value}`)).toContain("dev.passed=true");
    expect(newQuestions(asked, ["describe:main", "manual:main"]).map((q) => q.key)).toContain("stand:main");
    expect(newQuestions(asked, [])).toEqual([]);
  });
});
