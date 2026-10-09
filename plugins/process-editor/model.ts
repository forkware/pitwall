// A process as a recipe: numbered steps top to bottom, grouped by the status the task has while they run,
// with where each goes next when that is not simply the following step. No React here: the tests use it as is.
import type {
  AppState,
  EdgeSpec,
  FolderProcess,
  NodeSpec,
  StepInfo,
  SwitchSpec,
  ProcessInfo,
  ProcessNodeInfo,
  ProcessRun,
  ProcessSpec,
} from "#sdk/types";

/** Where a step leads, one way: "passed → 7", "↩ 4", "end". */
export interface NextPart {
  /** The value or answer that leads there, as the step words it; undefined for the only way. */
  label?: string;
  /** The values of `key` that lead there, for words in the user's language. */
  key?: string;
  values?: string[];
  /** "else": any other value. */
  otherwise?: boolean;
  to: string;
  /** Its number in the recipe; 0 for the end. */
  n: number;
  /** A step above: the task goes back. */
  back: boolean;
  end: boolean;
}

export interface RecipeRow {
  node: string;
  /** 1-based, the step's address: "↩ to step 4". */
  n: number;
  info: ProcessNodeInfo;
  spec: NodeSpec;
  step?: StepInfo;
  /** The status the task has while it runs: its own, or the last one set before it. */
  status?: string;
  /** The first row of a group of the same status: a header goes above it. */
  groupStart: boolean;
  /** Empty when it simply goes to the next step. */
  next: NextPart[];
  /** Nothing leads on from it. */
  deadEnd: boolean;
}

export const nodeSpec = (n: string | NodeSpec): NodeSpec => (typeof n === "string" ? { step: n } : n);
const isSwitch = (to: EdgeSpec[1]): to is SwitchSpec => typeof to === "object" && to !== null && "on" in to;

/** The step a node runs, by its full id or, for a step of the process's own plugin, by its short one. */
export function stepOf(steps: StepInfo[], plugin: string, id: string | undefined): StepInfo | undefined {
  if (!id) return undefined;
  return steps.find((s) => s.id === id) ?? steps.find((s) => s.id === `${plugin}.${id}`);
}

/**
 * How a step words a value of a key the process branches on: its outcomes ("passed"), the option of its
 * question with that id ("Ready to deploy"), else the value itself.
 */
export function valueLabel(step: StepInfo | undefined, key: string, value: string, node?: Pick<ProcessNodeInfo, "outcomes" | "questions">): string {
  const own = node?.outcomes?.[key]?.[value];
  if (own) return own;
  for (const q of node?.questions ?? []) {
    const option = q.options?.find((o) => o.id === value);
    if (option) return option.label;
  }
  const outcome = step?.outcomes[key]?.[value];
  if (outcome) return outcome;
  for (const q of step?.questions ?? []) {
    const option = q.options?.find((o) => o.id === value);
    if (option) return option.label;
  }
  return value;
}

export function recipe(w: Pick<ProcessInfo, "nodes" | "plugin">, spec: ProcessSpec, steps: StepInfo[], firstStatus = "todo"): RecipeRow[] {
  const order = Object.keys(spec.nodes);
  const number = (id: string) => order.indexOf(id) + 1;
  let status: string | undefined = firstStatus;
  let last: string | undefined;
  return order.map((node, i) => {
    const info = w.nodes.find((x) => x.id === node) ?? {
      id: node,
      step: "",
      label: node,
      role: "app" as const,
      questions: [],
      outcomes: {},
      skip: false,
    };
    const ns = nodeSpec(spec.nodes[node]);
    const step = stepOf(steps, w.plugin, ns.step);
    if (ns.status) status = ns.status;
    const groupStart = i === 0 || status !== last;
    last = status;
    const following = order[i + 1];
    const edges = spec.edges.filter(([from]) => from === node);
    const part = (to: string, label?: string, otherwise?: boolean, key?: string, values?: string[]): NextPart => ({
      ...(label !== undefined ? { label } : {}),
      ...(key ? { key, values } : {}),
      ...(otherwise ? { otherwise } : {}),
      to,
      n: to === "end" ? 0 : number(to),
      back: to !== "end" && number(to) <= i + 1,
      end: to === "end",
    });
    const next: NextPart[] = [];
    for (const [, to] of edges) {
      if (typeof to === "string") {
        // Simply on to the following step, or to the end after the last one: nothing to say.
        if (to === following || (to === "end" && !following)) continue;
        next.push(part(to));
      } else if (isSwitch(to)) {
        // Values that lead to the same step go together: "passed, skipped → 7".
        const byTarget = new Map<string, string[]>();
        for (const [value, target] of Object.entries(to.cases)) byTarget.set(target, [...(byTarget.get(target) ?? []), value]);
        for (const [target, values] of byTarget) {
          next.push(part(target, values.map((v) => valueLabel(step, to.on, v, info)).join(", "), false, to.on, values));
        }
        if (to.else) next.push(part(to.else, undefined, true));
      } else {
        for (const target of to.targets) next.push(part(target));
      }
    }
    return { node, n: i + 1, info, spec: ns, step, status, groupStart, next, deadEnd: edges.length === 0 };
  });
}

/** Where a process is used: folders that have its button, automations, processes that run it, tasks on it now. */
export interface Uses {
  folders: string[];
  /** The app's default list of buttons has it: every folder without its own list. */
  app: boolean;
  automations: string[];
  processes: string[];
  running: ProcessRun[];
}

export function usesOf(data: AppState | null | undefined, id: string): Uses {
  const has = (list: unknown) => Array.isArray(list) && (list as FolderProcess[]).some((x) => x?.process === id);
  return {
    folders: (data?.folders ?? []).filter((f) => has(f.settings.taskProcesses)).map((f) => f.id),
    app: has(data?.settings.values.taskProcesses?.value),
    automations: (data?.automations ?? []).filter((a) => a.process === id).map((a) => a.id),
    processes: (data?.processes.defs ?? []).filter((w) => w.id !== id && w.nodes.some((n) => n.process === id)).map((w) => w.id),
    running: (data?.processes.runs ?? []).filter((r) => r.process === id && r.state !== "done"),
  };
}

export const usedAnywhere = (u: Uses) => u.folders.length > 0 || u.app || u.automations.length > 0 || u.processes.length > 0;

/** Words a catalog search looks in: the process's name and description and its steps' names. */
export function searchText(w: ProcessInfo, steps: StepInfo[], words: (s: string) => string = (s) => s): string {
  const stepWords = w.nodes.map((n) => {
    const step = steps.find((s) => s.id === n.step);
    return [n.label, step ? words(step.label) : ""].join(" ");
  });
  return [w.label, w.description ?? "", ...stepWords].join(" ").toLowerCase();
}
