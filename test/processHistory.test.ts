import { describe, expect, it } from "vitest";
import type { ProcessSpec, ProcessTraceEntry } from "../src/sdk/types.ts";
import { duration, endedBadly, firstLine, historyItems, nextNodes, outputTexts, waitsForAgent } from "../src/ui/processHistory.ts";

// The development process, as in plugins/dev-flow/processes/dev.json.
const spec: Pick<ProcessSpec, "nodes" | "edges"> = {
  nodes: { describe: "d", code: "c", wait: "w", test: "t", manual: "m", stand: "s", merge: "g", "test-dev": "td" },
  edges: [
    ["start", "describe"],
    ["describe", "code"],
    ["code", "wait"],
    ["wait", "test"],
    ["test", { on: "dev.passed", cases: { true: "manual" }, else: "code" }],
    ["manual", { on: "dev.decision", cases: { stand: "stand", ready: "merge" }, else: "code" }],
    ["stand", { on: "dev.decision", cases: { retry: "stand", ready: "merge" }, else: "code" }],
    ["merge", { on: "dev.mergeResult", cases: { merged: "test-dev", conflict: "code" }, else: "end" }],
    ["test-dev", { on: "dev.devPassed", cases: { true: "end" }, else: "code" }],
  ],
};
const def = {
  nodes: [
    { id: "describe" },
    { id: "code", status: "in_progress" },
    { id: "wait", status: "in_progress" },
    { id: "test", status: "testing" },
    { id: "manual", status: "review" },
  ].map((n) => ({ step: "", label: n.id, role: "app" as const, questions: [], outcomes: {}, skip: false, ...n })),
};

let seq = 0;
const entry = (node: string, result: ProcessTraceEntry["result"] = "done", output: Record<string, unknown> | null = null): ProcessTraceEntry => ({
  seq: ++seq,
  node,
  step: `dev-flow.${node}`,
  startedAt: seq * 1000,
  endedAt: seq * 1000 + 500,
  result,
  output,
  answer: null,
  error: null,
});

describe("historyItems", () => {
  it("marks where the task went back and where its status changed, and leaves skipped steps out", () => {
    const items = historyItems(
      [entry("describe", "answered"), entry("code"), entry("wait"), entry("test"), entry("code"), entry("wait"), entry("test"), entry("manual", "asked"), entry("stand", "skipped")],
      def,
    );
    expect(items.map((i) => [i.node, i.back, i.stage])).toEqual([
      ["describe", false, null],
      ["code", false, "in_progress"],
      ["wait", false, null],
      ["test", false, "testing"],
      ["code", true, "in_progress"],
      ["wait", false, null],
      ["test", false, "testing"],
      ["manual", false, "review"],
    ]);
  });

  it("takes an inner process's step as its outer node", () => {
    expect(historyItems([entry("code/inner")], def)[0].node).toBe("code");
  });
});

describe("nextNodes", () => {
  it("lists what can still come, in the recipe's order, without going back", () => {
    expect(nextNodes(spec, "manual")).toEqual(["stand", "merge", "test-dev"]);
    expect(nextNodes(spec, "merge")).toEqual(["test-dev"]);
    expect(nextNodes(spec, "test-dev")).toEqual([]);
  });

  it("is empty without a process or a node", () => {
    expect(nextNodes(undefined, "manual")).toEqual([]);
    expect(nextNodes(spec, null)).toEqual([]);
  });
});

describe("duration", () => {
  const units = { h: "ч", m: "мин", s: "с" };
  it("gives the two largest units", () => {
    expect(duration(40_000, units)).toBe("40 с");
    expect(duration(12 * 60_000 + 5000, units)).toBe("12 мин");
    expect(duration(72 * 60_000, units)).toBe("1 ч 12 мин");
    expect(duration(2 * 3600_000, units)).toBe("2 ч");
    expect(duration(-5, units)).toBe("0 с");
  });
});

describe("waitsForAgent", () => {
  const choice = (options: { id: string; label: string; status?: string }[]) => ({
    state: "waiting" as const,
    request: { kind: "choice" as const, title: "The agent is working", options },
  });
  it("is the one-answer question while an agent of the task runs", () => {
    expect(waitsForAgent(choice([{ id: "done", label: "The agent finished" }]), [{ state: "running" }])).toBe(true);
  });
  it("is not a real choice, nor a question with no agent running", () => {
    expect(waitsForAgent(choice([{ id: "done", label: "Finished" }]), [{ state: "exited" }])).toBe(false);
    expect(waitsForAgent(choice([{ id: "ready", label: "Ready", status: "merging" }]), [{ state: "running" }])).toBe(false);
    expect(waitsForAgent(choice([{ id: "a", label: "A" }, { id: "b", label: "B" }]), [{ state: "running" }])).toBe(false);
  });
});

describe("outputTexts and firstLine", () => {
  it("keeps only what reads as text", () => {
    expect(outputTexts({ "dev.passed": false, "dev.feedback": "The tests failed:\n✗ export.test.ts", "dev.slug": "x" })).toEqual([
      { key: "dev.feedback", text: "The tests failed:\n✗ export.test.ts" },
    ]);
    expect(outputTexts(null)).toEqual([]);
  });
  it("cuts a message to its first line", () => {
    expect(firstLine("pnpm: not found\n  at spawn")).toBe("pnpm: not found");
    expect(firstLine("x".repeat(10), 5)).toBe("xxxx…");
    expect(firstLine(null)).toBe("");
  });
});

describe("endedBadly", () => {
  const outcomes = { "dev.passed": { true: "passed", false: "failed" } };
  it("is a false the process branches on", () => {
    expect(endedBadly({ "dev.passed": false, "dev.failures": 1 }, outcomes)).toBe(true);
    expect(endedBadly({ "dev.passed": true }, outcomes)).toBe(false);
    expect(endedBadly({ "dev.other": false }, outcomes)).toBe(false);
    expect(endedBadly(null, outcomes)).toBe(false);
  });
});
