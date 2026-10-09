// Changes to a process as data, shared by the server and the UI: no React, no core.
import type { EdgeSpec, NodeSpec, StepInfo, SwitchSpec, ProcessSpec } from "#sdk/types";

const isSwitch = (to: EdgeSpec[1]): to is SwitchSpec => typeof to === "object" && to !== null && "on" in to;
export const asNode = (n: string | NodeSpec): NodeSpec => (typeof n === "string" ? { step: n } : { ...n });

/**
 * Step and process ids written in full, so the spec means the same in another plugin's file: a code process names
 * its own plugin's steps without the prefix.
 */
export function qualify(spec: ProcessSpec, plugin: string, steps: StepInfo[]): ProcessSpec {
  const known = new Set(steps.map((s) => s.id));
  const full = (id: string) => (known.has(id) ? id : known.has(`${plugin}.${id}`) ? `${plugin}.${id}` : id);
  const nodes: ProcessSpec["nodes"] = {};
  for (const [name, n] of Object.entries(spec.nodes)) {
    const node = asNode(n);
    if (node.step) node.step = full(node.step);
    if (node.process && !node.process.includes(".")) node.process = `${plugin}.${node.process}`;
    nodes[name] = Object.keys(node).length === 1 && node.step ? node.step : node;
  }
  return { ...spec, nodes };
}

/** Changes one node of the spec; `null` removes a key of it. A node that is only a step is written as its id. */
export function setNode(spec: ProcessSpec, name: string, patch: Partial<Record<keyof NodeSpec, unknown>>): ProcessSpec {
  const node: Record<string, unknown> = { ...asNode(spec.nodes[name]) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined) delete node[key];
    else node[key] = value;
  }
  const keys = Object.keys(node);
  const compact = keys.length === 1 && keys[0] === "step" ? (node.step as string) : (node as NodeSpec);
  return { ...spec, nodes: { ...spec.nodes, [name]: compact } };
}

/** Sets a node's parameter; `undefined` drops it, so the step's default applies again. */
export function setParam(spec: ProcessSpec, name: string, key: string, value: unknown): ProcessSpec {
  const params = { ...(asNode(spec.nodes[name]).params ?? {}) };
  if (value === undefined) delete params[key];
  else params[key] = value;
  return setNode(spec, name, { params: Object.keys(params).length ? params : null });
}

/** Where a node goes for one value of the key it branches on, or for "otherwise" (`value` null). */
export function setCase(spec: ProcessSpec, from: string, value: string | null, to: string | null): ProcessSpec {
  return {
    ...spec,
    edges: spec.edges.map((edge): EdgeSpec => {
      const [f, branch] = edge;
      if (f !== from || !isSwitch(branch)) return edge;
      if (value === null) {
        const { else: _drop, ...rest } = branch;
        return [f, to ? { ...rest, else: to } : rest];
      }
      const cases = { ...branch.cases };
      if (to) cases[value] = to;
      else delete cases[value];
      return [f, { ...branch, cases }];
    }),
  };
}

/** Sets where a node simply goes next, replacing any plain edge from it. */
export function setNext(spec: ProcessSpec, from: string, to: string): ProcessSpec {
  const edges = spec.edges.filter(([f, t]) => !(f === from && typeof t === "string"));
  return { ...spec, edges: [...edges, [from, to]] };
}

/** What changed between two versions of a process, node by node, for the marks in the recipe. */
export interface SpecDiff {
  added: string[];
  removed: string[];
  /** Nodes whose settings or ways on changed. */
  changed: string[];
  /** Its name, description, icon or end status. */
  about: boolean;
  count: number;
}

export function diffSpecs(before: ProcessSpec, after: ProcessSpec): SpecDiff {
  const a = Object.keys(before.nodes);
  const b = Object.keys(after.nodes);
  const added = b.filter((n) => !a.includes(n));
  const removed = a.filter((n) => !b.includes(n));
  const out = (spec: ProcessSpec, node: string) => JSON.stringify(spec.edges.filter(([f]) => f === node));
  const changed = b.filter(
    (n) => a.includes(n) && (JSON.stringify(asNode(before.nodes[n])) !== JSON.stringify(asNode(after.nodes[n])) || out(before, n) !== out(after, n)),
  );
  const startMoved = out(before, "start") !== out(after, "start");
  const about = (["label", "description", "icon", "doneStatus", "hotkey"] as const).some((k) => (before[k] ?? "") !== (after[k] ?? ""));
  const order = a.filter((n) => b.includes(n)).join() !== b.filter((n) => a.includes(n)).join();
  return {
    added,
    removed,
    changed,
    about,
    count: added.length + removed.length + changed.length + (about ? 1 : 0) + (startMoved || order ? 1 : 0),
  };
}

export const sameSpec = (a: ProcessSpec, b: ProcessSpec) => diffSpecs(a, b).count === 0;
