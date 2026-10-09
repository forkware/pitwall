import { describe, expect, it } from "vitest";
import type { ProcessSpec } from "../../../src/sdk/types.ts";
import {
  dropBranch,
  duplicateNode,
  emptySpec,
  extractNodes,
  freeId,
  freeName,
  fromTemplate,
  insertBefore,
  makeBranch,
  moveNode,
  removeNode,
} from "../build.ts";

const chain: ProcessSpec = {
  id: "c",
  label: "C",
  nodes: { a: "s.a", b: "s.b", c: "s.c" },
  edges: [
    ["start", "a"],
    ["a", "b"],
    ["b", "c"],
    ["c", "end"],
  ],
};
const sorted = (spec: ProcessSpec) => spec.edges.map((e) => `${e[0]}>${typeof e[1] === "string" ? e[1] : JSON.stringify(e[1])}`).sort();

describe("building a process", () => {
  it("inserts a step before another: what led there leads to it", () => {
    const spec = insertBefore(chain, "b", "x", "s.x");
    expect(Object.keys(spec.nodes)).toEqual(["a", "x", "b", "c"]);
    expect(sorted(spec)).toEqual(["a>x", "b>c", "c>end", "start>a", "x>b"]);
    const last = insertBefore(chain, "end", "z", "s.z");
    expect(Object.keys(last.nodes)).toEqual(["a", "b", "c", "z"]);
    expect(sorted(last)).toEqual(["a>b", "b>c", "c>z", "start>a", "z>end"]);
  });

  it("makes the first step of an empty process", () => {
    const spec = insertBefore(emptySpec("p", "P"), "end", "first", "s.a");
    expect(sorted(spec)).toEqual(["first>end", "start>first"]);
  });

  it("removes a step and joins its neighbours, also in branches that led to it", () => {
    const branched: ProcessSpec = { ...chain, edges: [...chain.edges.filter(([f]) => f !== "c"), ["c", { on: "k", cases: { no: "b" }, else: "end" }]] };
    const spec = removeNode(branched, "b");
    expect(Object.keys(spec.nodes)).toEqual(["a", "c"]);
    expect(sorted(spec)).toEqual(['c>{"on":"k","cases":{"no":"c"},"else":"end"}', "a>c", "start>a"].sort());
  });

  it("moves a step in a straight run, in the recipe and in the way through it", () => {
    const up = moveNode(chain, "b", -1);
    expect(Object.keys(up.nodes)).toEqual(["b", "a", "c"]);
    expect(sorted(up)).toEqual(["a>c", "b>a", "c>end", "start>b"]);
    expect(moveNode(chain, "a", -1)).toBe(chain);
    const down = moveNode(chain, "b", 1);
    expect(sorted(down)).toEqual(["a>c", "b>end", "c>b", "start>a"]);
  });

  it("duplicates a step right after it", () => {
    const { spec, name } = duplicateNode(chain, "b");
    expect(name).toBe("b-2");
    expect(Object.keys(spec.nodes)).toEqual(["a", "b", "b-2", "c"]);
    expect(sorted(spec)).toEqual(["a>b", "b-2>c", "b>b-2", "c>end", "start>a"]);
  });

  it("turns a way on into a branch and back", () => {
    const spec = makeBranch(chain, "b", "choice.answer", ["Done", "Again"]);
    expect(spec.edges.find(([f]) => f === "b")).toEqual(["b", { on: "choice.answer", cases: { Done: "c", Again: "c" }, else: "c" }]);
    expect(sorted(dropBranch(spec, "b"))).toEqual(sorted(chain));
  });

  it("names nodes and processes freely", () => {
    expect(freeName(chain, "basic-steps.a")).toBe("a-2");
    expect(freeId("Статьи", new Set())).toBe("process");
    expect(freeId("My flow!", new Set(["my-flow"]))).toBe("my-flow-2");
  });

  it("copies a template in the user's words, its branches with them", () => {
    const template = {
      full: "t.x",
      id: "x",
      label: "X",
      template: true,
      nodes: { check: { step: "s.ask", params: { question: "Is it done?", options: "Done\nOnce more" } } },
      edges: [["start", "check"], ["check", { on: "choice.answer", cases: { Done: "end" }, else: "check" }]],
    } as ProcessSpec & { full: string };
    const words: Record<string, string> = { "tvalue:t.x:Done": "Готово", "tvalue:t.x:Once more": "Ещё раз", "tparam:t.x:check:question": "Готово?" };
    const copy = fromTemplate(template, "mine", "Моё", (k) => words[k]);
    expect(copy).toMatchObject({ id: "mine", label: "Моё", nodes: { check: { params: { question: "Готово?", options: "Готово\nЕщё раз" } } } });
    expect(copy.template).toBeUndefined();
    expect(copy.edges[1]).toEqual(["check", { on: "choice.answer", cases: { Готово: "end" }, else: "check" }]);
  });
});


describe("taking steps out into a process", () => {
  const keys = (step: string) =>
    ({ "s.a": { reads: [], writes: ["a.out"] }, "s.b": { reads: ["a.out"], writes: ["b.out"] }, "s.c": { reads: ["b.out"], writes: [] } })[step] ?? {
      reads: [],
      writes: [],
    };

  it("puts the steps in a process of their own and runs it in their place", () => {
    const result = extractNodes(chain, ["b", "c"], { id: "bc", label: "BC", process: "my-processes.bc" }, keys);
    if ("error" in result) throw new Error(result.error);
    expect(result.child).toMatchObject({ id: "bc", inputs: ["a.out"], outputs: ["b.out"], nodes: { b: "s.b", c: "s.c" } });
    expect(sorted(result.child)).toEqual(["b>c", "c>end", "start>b"]);
    expect(result.parent.nodes).toEqual({ a: "s.a", bc: { process: "my-processes.bc" } });
    expect(sorted(result.parent)).toEqual(["a>bc", "bc>end", "start>a"]);
  });

  it("refuses steps that are not together, or that are entered in the middle", () => {
    expect(extractNodes(chain, ["a", "c"], { id: "x", label: "X", process: "m.x" }, keys)).toEqual({ error: "notTogether" });
    const loop: ProcessSpec = { ...chain, edges: [...chain.edges, ["a", { on: "k", cases: { y: "c" } }]] as never };
    expect(extractNodes(loop, ["b", "c"], { id: "x", label: "X", process: "m.x" }, keys)).toEqual({ error: "manyWaysIn" });
  });
});
