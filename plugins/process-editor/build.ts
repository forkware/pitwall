// Building a process from steps: insert, remove, move, duplicate, branch. Each keeps the way through the process
// whole where it can, so the recipe still reads top to bottom. No React, no core.
import type { EdgeSpec, NodeSpec, SwitchSpec, ProcessSpec } from "#sdk/types";
import { asNode } from "./specs.ts";

const isSwitch = (to: EdgeSpec[1]): to is SwitchSpec => typeof to === "object" && to !== null && "on" in to;
const order = (spec: ProcessSpec) => Object.keys(spec.nodes);

/** A free node name from a step's or process's id: "agent-task", "agent-task-2". */
export function freeName(spec: ProcessSpec, from: string): string {
  const base =
    (from.split(".").pop() ?? "step")
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "step";
  let name = base;
  for (let i = 2; name in spec.nodes || name === "start" || name === "end"; i++) name = `${base}-${i}`;
  return name;
}

/** Points every way that led to `from` at `to` instead; with `skip`, not the ways out of that node. */
function redirect(edges: EdgeSpec[], from: string, to: string, skip?: string): EdgeSpec[] {
  return edges.map((edge): EdgeSpec => {
    const [f, t] = edge;
    if (f === skip) return edge;
    if (typeof t === "string") return t === from ? [f, to] : edge;
    if (isSwitch(t)) {
      const cases = Object.fromEntries(Object.entries(t.cases).map(([v, n]) => [v, n === from ? to : n]));
      return [f, { ...t, cases, ...(t.else !== undefined ? { else: t.else === from ? to : t.else } : {}) }];
    }
    return edge;
  });
}

/**
 * Inserts a node before `before` ("end" for the end): whatever led there leads to the new node, which leads on there.
 * In an empty process, the new node is the whole of it.
 */
export function insertBefore(spec: ProcessSpec, before: string, name: string, node: string | NodeSpec): ProcessSpec {
  const names = order(spec);
  const at = before === "end" ? names.length : names.indexOf(before);
  const nodes: ProcessSpec["nodes"] = {};
  names.forEach((n, i) => {
    if (i === at) nodes[name] = node;
    nodes[n] = spec.nodes[n];
  });
  if (at === names.length || at < 0) nodes[name] = node;
  let edges = spec.edges;
  if (!edges.some(([f]) => f === "start")) edges = [...edges, ["start", "end"]];
  edges = redirect(edges, before, name, name);
  return { ...spec, nodes, edges: [...edges, [name, before]] };
}

/**
 * Removes a node: what led to it leads where it simply went on (or, when it branched, to the node after it in the
 * recipe), and its own ways go.
 */
export function removeNode(spec: ProcessSpec, name: string): ProcessSpec {
  const names = order(spec);
  const own = spec.edges.filter(([f]) => f === name);
  const plain = own.find(([, t]) => typeof t === "string")?.[1] as string | undefined;
  const onward = plain && plain !== name ? plain : (names[names.indexOf(name) + 1] ?? "end");
  const nodes = { ...spec.nodes };
  delete nodes[name];
  const edges = redirect(
    spec.edges.filter(([f]) => f !== name),
    name,
    onward,
  ).filter(([f, t]) => !(f === t));
  return { ...spec, nodes, edges };
}

/**
 * Moves a node one place up or down in the recipe. In a straight run of steps (… → a → b → …) it swaps them in the
 * way through the process too; with branches around, only its place in the recipe changes.
 */
export function moveNode(spec: ProcessSpec, name: string, by: -1 | 1): ProcessSpec {
  const names = order(spec);
  const i = names.indexOf(name);
  const j = i + by;
  if (i < 0 || j < 0 || j >= names.length) return spec;
  const [first, second] = by < 0 ? [names[j], name] : [name, names[j]];
  const reordered = [...names];
  reordered[i] = names[j];
  reordered[j] = name;
  const nodes = Object.fromEntries(reordered.map((n) => [n, spec.nodes[n]]));
  // first → second, each with one plain way out: swap them in the chain.
  const out = (n: string) => spec.edges.filter(([f]) => f === n);
  const straight = (n: string) => out(n).length === 1 && typeof out(n)[0][1] === "string";
  if (!straight(first) || !straight(second) || out(first)[0][1] !== second) return { ...spec, nodes };
  const after = out(second)[0][1] as string;
  let edges = redirect(spec.edges, first, second, second).filter(([f]) => f !== first && f !== second);
  edges = [...edges, [second, first], [first, after === first ? second : after]];
  return { ...spec, nodes, edges };
}

/**
 * A copy of a node right after it in the recipe. A node that simply goes on leads to its copy, which goes where it
 * went; a branching one keeps its branches, and the copy gets the same ones.
 */
export function duplicateNode(spec: ProcessSpec, name: string): { spec: ProcessSpec; name: string } {
  const node = asNode(spec.nodes[name]);
  const copy = freeName(spec, node.step ?? node.process ?? name);
  const names = order(spec);
  const nodes: ProcessSpec["nodes"] = {};
  for (const n of names) {
    nodes[n] = spec.nodes[n];
    if (n === name) nodes[copy] = { ...node };
  }
  const own = spec.edges.filter(([f]) => f === name);
  const plain = own.length === 1 && typeof own[0][1] === "string" ? own[0][1] : undefined;
  const edges: EdgeSpec[] = plain
    ? [...spec.edges.filter(([f]) => f !== name), [name, copy], [copy, plain]]
    : [...spec.edges, ...own.map(([, t]): EdgeSpec => [copy, t] as EdgeSpec)];
  return { spec: { ...spec, nodes, edges }, name: copy };
}

/** Turns a node's plain way on into a branch on one of its keys, every value going where it went. */
export function makeBranch(spec: ProcessSpec, name: string, key: string, values: string[]): ProcessSpec {
  const names = order(spec);
  const plain = (spec.edges.find(([f, t]) => f === name && typeof t === "string")?.[1] as string | undefined) ?? names[names.indexOf(name) + 1] ?? "end";
  const edges = spec.edges.filter(([f, t]) => !(f === name && typeof t === "string"));
  return { ...spec, edges: [...edges, [name, { on: key, cases: Object.fromEntries(values.map((v) => [v, plain])), else: plain }]] };
}

/** The branch goes: the node simply goes on where "otherwise" went. */
export function dropBranch(spec: ProcessSpec, name: string): ProcessSpec {
  const branch = spec.edges.find(([f, t]) => f === name && isSwitch(t))?.[1] as SwitchSpec | undefined;
  if (!branch) return spec;
  const names = order(spec);
  const to = branch.else ?? Object.values(branch.cases)[0] ?? names[names.indexOf(name) + 1] ?? "end";
  return { ...spec, edges: [...spec.edges.filter(([f, t]) => !(f === name && isSwitch(t))), [name, to]] };
}

/** An empty process: it starts and ends. */
export function emptySpec(id: string, label: string): ProcessSpec {
  return { id, label, icon: "workflow", nodes: {}, edges: [["start", "end"]] };
}

/** A free process id from its name: latin letters, digits and dashes; "process" when nothing is left. */
export function freeId(label: string, taken: Set<string>): string {
  const base =
    label
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "process";
  let id = base;
  for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
  return id;
}

/**
 * A copy of a template (or of any process) as the user's own: in their language when its plugin gives the words
 * (`tlabel:<template>:<node>`, `tparam:<template>:<node>:<param>`, `tvalue:<template>:<value>` for answers and the
 * branches on them).
 */
export function fromTemplate(
  template: ProcessSpec & { full: string },
  id: string,
  label: string,
  words: (key: string) => string | undefined,
): ProcessSpec {
  const value = (v: string) => words(`tvalue:${template.full}:${v}`) ?? v;
  const nodes: ProcessSpec["nodes"] = {};
  for (const [name, n] of Object.entries(template.nodes)) {
    const node = asNode(n);
    const params = node.params
      ? Object.fromEntries(
          Object.entries(node.params).map(([k, v]) => {
            const own = words(`tparam:${template.full}:${name}:${k}`);
            if (own !== undefined) return [k, own];
            return [k, typeof v === "string" ? v.split("\n").map(value).join("\n") : v];
          }),
        )
      : undefined;
    const nodeLabel = words(`tlabel:${template.full}:${name}`) ?? node.label;
    const copy: NodeSpec = { ...node, ...(params ? { params } : {}), ...(nodeLabel ? { label: nodeLabel } : {}) };
    nodes[name] = Object.keys(copy).length === 1 && copy.step ? copy.step : copy;
  }
  const edges = template.edges.map((edge): EdgeSpec => {
    const [f, t] = edge;
    if (!isSwitch(t)) return edge;
    return [f, { ...t, cases: Object.fromEntries(Object.entries(t.cases).map(([v, n]) => [value(v), n])) }];
  });
  const { full: _full, template: _template, overrides: _o, base: _b, ...rest } = template;
  return { ...rest, id, label, nodes, edges };
}

/**
 * Takes steps that follow each other out into a process of their own, run in their place as one step. The way into
 * them must come to the first of them, and the way out of them must go to one place; otherwise it says why not.
 * `reads` and `writes` of a step id: what the new process takes and gives.
 */
export function extractNodes(
  spec: ProcessSpec,
  picked: string[],
  child: { id: string; label: string; process: string },
  keys: (step: string) => { reads: string[]; writes: string[] },
): { parent: ProcessSpec; child: ProcessSpec } | { error: "notTogether" | "manyWaysIn" | "manyWaysOut" } {
  const names = order(spec);
  const inside = names.filter((n) => picked.includes(n));
  const at = names.indexOf(inside[0]);
  if (inside.some((n, i) => names.indexOf(n) !== at + i)) return { error: "notTogether" };
  const set = new Set(inside);
  const targets = (edge: EdgeSpec) => {
    const to = edge[1];
    if (typeof to === "string") return [to];
    if (isSwitch(to)) return [...Object.values(to.cases), ...(to.else ? [to.else] : [])];
    return to.targets;
  };
  const intoFromOutside = spec.edges.filter(([f]) => !set.has(f)).flatMap((e) => targets(e).filter((t) => set.has(t)));
  if (intoFromOutside.some((t) => t !== inside[0])) return { error: "manyWaysIn" };
  const out = new Set(spec.edges.filter(([f]) => set.has(f)).flatMap((e) => targets(e).filter((t) => !set.has(t))));
  if (out.size > 1) return { error: "manyWaysOut" };
  const exit = [...out][0] ?? "end";

  const toEnd = (name: string) => (name === exit ? "end" : name);
  const childEdges: EdgeSpec[] = [
    ["start", inside[0]],
    ...spec.edges
      .filter(([f]) => set.has(f))
      .map(([f, to]): EdgeSpec => {
        if (typeof to === "string") return [f, toEnd(to)];
        if (isSwitch(to)) {
          return [f, { ...to, cases: Object.fromEntries(Object.entries(to.cases).map(([v, n]) => [v, toEnd(n)])), ...(to.else ? { else: toEnd(to.else) } : {}) }];
        }
        return [f, { targets: to.targets.map(toEnd) }];
      }),
  ];
  const written = new Set<string>();
  const read = new Set<string>();
  for (const n of inside) {
    const node = asNode(spec.nodes[n]);
    if (!node.step) continue;
    const k = keys(node.step);
    for (const r of k.reads) if (!r.endsWith("?")) read.add(r);
    for (const w of k.writes) written.add(w);
  }
  const inputs = [...read].filter((k) => !written.has(k));
  const childSpec: ProcessSpec = {
    id: child.id,
    label: child.label,
    icon: "workflow",
    ...(inputs.length ? { inputs } : {}),
    ...(written.size ? { outputs: [...written] } : {}),
    nodes: Object.fromEntries(inside.map((n) => [n, spec.nodes[n]])),
    edges: childEdges,
  };

  const name = freeName({ ...spec, nodes: Object.fromEntries(names.filter((n) => !set.has(n)).map((n) => [n, spec.nodes[n]])) }, child.process);
  const nodes: ProcessSpec["nodes"] = {};
  for (const n of names) {
    if (n === inside[0]) nodes[name] = { process: child.process };
    if (!set.has(n)) nodes[n] = spec.nodes[n];
  }
  const edges = redirect(
    spec.edges.filter(([f]) => !set.has(f)),
    inside[0],
    name,
  );
  return { parent: { ...spec, nodes, edges: [...edges, [name, exit]] }, child: childSpec };
}
