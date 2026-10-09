// The contract between the core and a plugin's server part (plugins/<id>/server.ts).
import type {
  AppInfo,
  Automation,
  AutomationRunView,
  Continuation,
  Folder,
  Meta,
  Session,
  SettingDef,
  StatusDef,
  Task,
  UserRequest,
  ProcessInfo,
  ProcessRun,
  StepInfo,
  ParamDef,
  QuestionInfo,
  StepRole,
  SwitchSpec,
  InputDef,
  ProcessSpec,
  ProcessTraceEntry,
  ProcessVersion,
  ProcessRunOptions,
  ProviderInfo,
} from "./types.ts";

export type * from "./types.ts";

export type Unsubscribe = () => void;

/** Returns true to allow the transition, or a reason to refuse it. */
export type TransitionGuard = (task: Task, from: string, to: string) => true | string;

/** Returns the directory to run agents for the task in, or undefined to let others decide. */
export type WorkspaceResolver = (task: Task, folders: Folder[]) => string | undefined;

/**
 * Brings back the directory an ended session ran in, when it is gone (a worktree removed after the merge, say),
 * so the session can be continued there.
 */
export interface CwdRestorer {
  /** What restoring would do, as a string key the UI shows with t(); undefined when this one cannot. */
  offer: (session: Session, task: Task) => string | undefined;
  /** Makes the directory and returns where the session continues: best its old cwd, where its conversation is. */
  restore: (session: Session, task: Task) => string;
}

export interface AgentProvider {
  id: string;
  label: string;
  /** Executable looked up in PATH. */
  command: string;
  /**
   * Arguments for a new session; `prompt` is the first message, when there is one.
   * `sessionId` is the app's id for the session, a UUID; an agent that accepts its own id at start can take it.
   */
  args?: (options: { prompt?: string; sessionId: string }) => string[];
  env?: Record<string, string>;
  /**
   * Running it once without a terminal, for a short job: `claude -p`, `codex exec`.
   * `outputFile`: where the agent may write its last message; when the file is there afterwards, it is the answer,
   * else what the agent printed.
   */
  exec?: (options: { prompt: string; outputFile: string }) => string[];
  /** Whether the agent's screen, quiet, shows it asking the user (a permission prompt). Gets the screen as text. */
  asks?: (screen: string) => boolean;
  /**
   * Whether the agent's screen, quiet, shows it waiting to go on by itself (Claude's usage limit until it resets).
   * Such a session counts as busy: nobody asks it whether it finished. Gets the screen as text.
   */
  waits?: (screen: string) => boolean;
  /** Continuing a conversation after the app restarted. Without it, a suspended session starts afresh. */
  resume?: {
    /**
     * The agent's id for the session's conversation, or undefined while it has none (nothing was said yet).
     * Called each second while the session runs, and on resume, until it returns one; the core keeps it.
     * `taken` holds the ids other sessions already have.
     */
    find: (session: Session, taken: ReadonlySet<string>) => string | undefined;
    /** Arguments that continue that conversation. */
    args: (agentSessionId: string) => string[];
  };
}

export interface StartOptions {
  /** Provider id; the app's default provider when omitted. */
  provider?: string;
  prompt?: string;
}

export interface RunOptions {
  /** Provider id; the default provider of the task's folder, or the app's, when omitted. */
  provider?: string;
  /** The folder whose default provider to use. */
  folderId?: string;
  cwd?: string;
  /** Default 5 minutes; the control's `extend` gives more. Past it the agent is stopped and the run fails. */
  timeoutMs?: number;
  /**
   * "session": when the agent cannot run without a terminal (its provider has no `exec`) or that run fails, run it
   * in a terminal nobody sees; it answers with `pitwall answer`, asks the user with `pitwall ask` and
   * reports with `pitwall progress`. Without it such an agent is not used.
   */
  fallback?: "session";
  /** Keep the session after its answer, to `ask` it more. */
  keep?: boolean;
  /** The run started: how to answer its questions, wait longer or stop it. */
  onStart?: (run: RunControl) => void;
  /** The agent asked the user (`pitwall ask`); answer with `run.reply`. */
  onAsk?: (question: string) => void;
  /** What the agent says it is doing (`pitwall progress`). */
  onProgress?: (text: string) => void;
  /** Each second in a session: whether the agent waits for a permission on its screen, how long it has been silent. */
  onActivity?: (activity: RunActivity) => void;
}

export interface RunActivity {
  /** Quiet on a question its provider recognizes (a permission prompt): the user answers it in the terminal. */
  asking: boolean;
  /** Milliseconds without output, a question or a report; 0 while the agent waits to go on by itself (`waits`). */
  silentFor: number;
  /** When the run is stopped unless extended. */
  deadline: number;
}

/** A running `agents.run`. */
export interface RunControl {
  /** "exec": without a terminal; "session": in a terminal nobody sees, `sessionId` (the UI can show it). */
  mode: "exec" | "session";
  sessionId: string | null;
  provider: string;
  /** Types the user's answer to the agent's question into its terminal. */
  reply: (text: string) => void;
  /** A kept session: sends another message and resolves to the agent's next answer. */
  ask: (text: string) => Promise<string>;
  /** Moves the deadline this much later. */
  extend: (ms: number) => void;
  /** Stops the agent; the run fails with "Stopped". */
  stop: () => void;
  /** The end of its screen, for "show what it did". */
  screen: () => string;
}

/**
 * What an agent says with `pitwall <name> [text]` (the text comes from the arguments or stdin).
 * The handler's return value is printed to the agent; a thrown error too, and the command fails.
 */
export interface SignalDef {
  /** Lower case, as typed: "done", "rename". */
  name: string;
  /** One line the agent sees in `pitwall help`. */
  description: string;
  handler: (signal: { task: Task; session: Session; text: string }) => string | void | Promise<string | void>;
}

/** A setting a plugin defines. Its key gets the plugin's id as a prefix: "targetBranch" → "<id>.targetBranch". */
export type SettingInput = Omit<SettingDef, "plugin" | "options" | "env"> & {
  /** The choices of a "select"; a function when they change while the app runs. */
  options?: SettingDef["options"] | (() => NonNullable<SettingDef["options"]>);
  /** Checks a value beyond its type: returns why it is wrong, or undefined when it is fine. */
  validate?: (value: unknown) => string | undefined;
};

/** Process state: "namespace.name" → value, e.g. "git.workspace", "github.issue". */
export type FlowState = Record<string, unknown>;

export interface StepContext {
  /** The task as it is now: the user may have edited its body since the process started. */
  task: Task;
  /** The keys the step declared in `reads`, and only those. */
  state: FlowState;
  /**
   * What the process passed to this node (`nodes: { fix: { step: "agent.develop", params: { ... } } }`) over the
   * defaults of the step's `params`, with `{ setting }` defaults read for the task's folder.
   */
  params: Record<string, unknown>;
  /** The run is a trial from the editor. */
  trial: boolean;
  /**
   * Asks the user and stops the process until they answer, across restarts too. Returns the answer.
   * When the answer comes the step runs again from its start, so do side effects after ask(),
   * or make them safe to repeat.
   */
  ask: <T = any>(request: UserRequest) => T;
  /** Renames the task or changes its body, e.g. from what the user answered or what an agent made of it. */
  setTask: (patch: { title?: string; body?: string }) => Task;
  /**
   * Tells the user what the step is doing while it works: the task's row in the tree shows a clock and
   * the task's page this text. A new step starts without one; null clears it.
   */
  progress: (text: string | null) => void;
}

/** A step of processes. Its plugin's permissions cover what it does. */
export interface StepDef {
  /** Gets the plugin's id as a prefix: "name" → "<id>.name". */
  id: string;
  label: string;
  description?: string;
  /** State keys it needs, "namespace.name"; "github.issue?" is optional. Only these reach it. */
  reads?: string[];
  /** State keys it may return. Returning another one fails the step. */
  writes?: string[];
  /** A lucide icon name in kebab case for the recipe. */
  icon?: string;
  /** Where the editor's step picker lists it: "you", "agent", "git", "github", "tests", or a word of the plugin's. */
  group?: string;
  /** Who does its work; by default "you" when it declares questions it always asks, else "app". */
  role?: StepRole;
  /** Words for the keys it reads and writes, so the editor never shows a key: "git.branch" → "the task's branch". */
  labels?: Record<string, string>;
  /** Its parameters: the form of its card in the editor. A node's `params` override their defaults. */
  params?: Record<string, ParamDef>;
  /**
   * The values of a key it writes that a process branches on, with words: { "tests.passed": { true: "passed",
   * false: "failed" } }; from its node's parameters when they decide them.
   */
  outcomes?: Record<string, Record<string, string>> | ((params: Record<string, unknown>) => Record<string, Record<string, string>>);
  /** What it asks the user, so the editor and automations know before it asks; from its node's parameters. */
  questions?: QuestionInfo[] | ((params: Record<string, unknown>) => QuestionInfo[]);
  /** It changes the world outside the app (pushes, merges, posts): a trial run without consequences skips it. */
  sideEffects?: boolean;
  /** Why a node of it cannot run now, from its parameters (a step still being made); undefined when it can. */
  blocked?: (params: Record<string, unknown>) => string | undefined;
  run: (step: StepContext) => FlowState | void | Promise<FlowState | void>;
}

/** Picks the next node from the state; must return one of the targets listed with it. */
export type Router = (state: FlowState) => string;

export interface ProcessNode {
  /** Step id; a step of the same plugin may go without the prefix. */
  step?: string;
  /** Another process run as this node; its keys stay its own but for `in` and `out`. */
  process?: string;
  /** The inner process's input key → the key of this process it takes it from; by default the same key. */
  in?: Record<string, string>;
  /** The inner process's output key → the key of this process it is written to; by default the same key. */
  out?: Record<string, string>;
  /** The inner process as it was when saved: its later changes do not reach this one. */
  pin?: ProcessSpec;
  label?: string;
  params?: Record<string, unknown>;
  /** The task's status while this node runs. While a process runs, it alone sets the status. */
  status?: string;
  /** Passed by without running. */
  skip?: boolean;
}

/** A graph of steps. Nodes are named by the process; "start" and "end" are the graph's ends. */
export interface ProcessDef {
  /** Gets the plugin's id as a prefix: "name" → "<id>.name". */
  id: string;
  label: string;
  description?: string;
  /** A lucide icon name in kebab case ("bug", "git-branch") for the button that creates a task with it. */
  icon?: string;
  /** Keys that create a task with it in the folder in focus, e.g. "Alt+B"; folders can change them. */
  hotkey?: string;
  nodes: Record<string, string | ProcessNode>;
  /** `[from, to]`, `[from, { on, cases, else }]` to branch on a key, or `[from, router, targets]` in code. */
  edges: ([from: string, to: string] | [from: string, branch: SwitchSpec] | [from: string, router: Router, targets: string[]])[];
  /** State keys given when it starts, so steps may read them; with labels, the fields an automation fills. */
  inputs?: string[] | Record<string, InputDef>;
  /** The keys a process that runs this one as a node gets back. */
  outputs?: string[];
  /** Offered as a start for a new process, not on its own. */
  template?: boolean;
  /** The status at the end; "done" when omitted. */
  doneStatus?: string;
}

/**
 * What a plugin can do. Reads are free. Every write needs a permission declared in
 * plugin.json; the core records each write and raises an alarm for undeclared ones.
 */
export interface PluginContext {
  /** The plugin's id: its directory name. */
  id: string;
  app: AppInfo;
  log: (...args: unknown[]) => void;

  events: {
    /** Core events: folder.*, task.*, task.status.changed, session.*, audit.alarm. */
    on: (name: string, handler: (payload: any) => void) => Unsubscribe;
    /** Emits `<plugin id>.<name>`. */
    emit: (name: string, payload?: unknown) => void;
  };

  statuses: {
    list: () => StatusDef[];
    /** Permission: statuses:register */
    register: (defs: Omit<StatusDef, "plugin">[]) => void;
  };

  folders: {
    list: () => Folder[];
    get: (id: string) => Folder | undefined;
    /** The folder and its ancestors, nearest first. */
    chain: (id: string) => Folder[];
    /** Permission: folders:write */
    create: (input: { name: string; parentId?: string | null; meta?: Meta }) => Folder;
    /** Permission: folders:write. `meta` is merged per key. */
    update: (id: string, patch: { name?: string; parentId?: string | null; meta?: Meta }) => Folder;
  };

  tasks: {
    /** The tasks in the tree; `archived: true` gives the archived ones instead, "all" both. */
    list: (folderId?: string, options?: { archived?: boolean | "all" }) => Task[];
    /** Any task, archived ones too: `task.archivedAt` says which. */
    get: (id: string) => Task | undefined;
    /** Permission: tasks:write */
    create: (input: { folderId: string; title: string; body?: string; status?: string; meta?: Meta }) => Task;
    /** Permission: tasks:write. `meta` is merged per key; `workspace` is where its agents start (null: the folder's). */
    update: (
      id: string,
      patch: { title?: string; body?: string; folderId?: string; meta?: Meta; workspace?: string | null },
    ) => Task;
    /** Permission: tasks:write. Runs the guards, then emits task.status.changed. */
    setStatus: (id: string, status: string) => Task;
    /** Permission: tasks:guard */
    guardTransition: (guard: TransitionGuard) => Unsubscribe;
    /** Permission: tasks:write. Sends the task to the archive (its agents end); emits task.archived. */
    archive: (id: string) => Task;
    /** Permission: tasks:write. Brings an archived task back where it was; emits task.restored. */
    restore: (id: string) => Task;
    /** Permission: tasks:write. Deletes the task for good, with its agents' sessions. */
    delete: (id: string) => void;
  };

  agents: {
    sessions: (taskId?: string) => Session[];
    /** The agents installed as plugins: whether each is in PATH and can answer without a terminal. */
    providers: () => ProviderInfo[];
    /** Permission: agents:provide */
    registerProvider: (provider: AgentProvider) => void;
    /** Permission: agents:spawn */
    start: (taskId: string, options?: StartOptions) => Session;
    /** Permission: agents:spawn. Types a message into a running agent and presses Enter. */
    send: (sessionId: string, text: string) => void;
    /**
     * Permission: agents:spawn. Runs an agent once without a terminal (its provider's `exec`), or with `fallback:
     * "session"` in a terminal nobody sees; resolves to its answer. A failure carries `screen`: what it printed last.
     */
    run: (prompt: string, options?: RunOptions) => Promise<string>;
    /**
     * Permission: agents:spawn. Ends a running agent; its session stays, ended, and is not continued after a restart.
     * `reason` (default "stopped") is kept as its `exitReason`: a string key the UI shows with t().
     */
    stop: (sessionId: string, reason?: string) => void;
    /** Whether an ended session can be continued in its tab, and whether in the same conversation. */
    continuation: (sessionId: string) => Continuation;
    /** Permission: agents:spawn. Starts an ended session's agent again in its tab, restoring its directory if it can. */
    continue: (sessionId: string) => Session;
    /** The last lines on the agent's screen, as plain text. */
    screen: (sessionId: string) => string;
    /** Everything the agent printed, as plain text (up to the last 4 MB): its conversation, for search, say. */
    log: (sessionId: string) => string;
    /** What agents can say with `pitwall <name>`; a second handler for a name replaces the first. */
    onSignal: (signal: SignalDef) => void;
  };

  /** Steps: units of work that processes are built from. */
  steps: {
    list: () => StepInfo[];
    /** Permission: steps:register */
    register: (step: StepDef) => void;
    /** Permission: steps:register. Takes back a step of the plugin's own (its file was deleted, say). */
    remove: (id: string) => void;
  };

  /** Processes: what happens to a task, as a LangGraph graph of steps. Their state is kept in the database. */
  processes: {
    list: () => ProcessInfo[];
    run: (taskId: string) => ProcessRun | undefined;
    /** Permission: processes:register */
    register: (process: ProcessDef) => void;
    /** Permission: processes:run. A task gets one process; starting a second one is refused. */
    start: (taskId: string, processId: string, input?: FlowState) => ProcessRun;
    /** Permission: processes:run. Answers what the waiting step asked. */
    resume: (taskId: string, answer: unknown) => ProcessRun;
    /** The steps a task's process ran, oldest first. */
    trace: (taskId: string) => ProcessTraceEntry[];
    /** The saved versions of a file process, newest first. */
    versions: (processId: string) => ProcessVersion[];
    /**
     * Permission: processes:register. Writes a process as plugins/<plugin>/processes/<id>.json and loads it;
     * `note` stays with the version ("what the user asked for"). Returns the process's full id.
     */
    save: (plugin: string, spec: ProcessSpec, note?: string) => string;
    /** Permission: processes:register. Deletes a file process; its versions stay. */
    remove: (processId: string) => void;
    /** A process that is not saved (a draft), as `list()` would show it: its nodes, issues, what it asks. */
    preview: (plugin: string, spec: ProcessSpec) => ProcessInfo;
    /** Permission: processes:run. Moves a waiting or failed task to the process's current version. */
    upgrade: (taskId: string) => ProcessRun;
    /** Permission: processes:run. A new task in the folder that follows the process; a trial stays out of the tree. */
    createTask: (
      input: { folderId: string; title: string; body?: string; meta?: Meta },
      processId: string,
      options?: { input?: FlowState; options?: ProcessRunOptions; spec?: ProcessSpec },
    ) => Task;
  };

  /** Automations: tasks made by a schedule or a webhook. The core runs them; plugins read them and hear `automation.run`. */
  automations: {
    list: () => Automation[];
    /** Its log, newest first, with what each run's task is now. */
    runs: (automationId: string) => AutomationRunView[];
  };

  workspaces: {
    /** Permission: workspaces:resolve */
    registerResolver: (resolver: WorkspaceResolver) => void;
    /** Permission: workspaces:resolve. Brings back an ended session's directory when it is gone. */
    registerRestorer: (restorer: CwdRestorer) => void;
    /** The directory the resolvers give the task's folder, ignoring the task's own workspace; undefined when none does. */
    ofFolder: (taskId: string) => string | undefined;
  };

  /** Procedures the plugin's UI calls with `rpc(pluginId, name, input)`. */
  rpc: {
    handle: (name: string, handler: (input: any) => unknown) => void;
  };

  /**
   * Settings the user changes in the app, in the settings file, with PITWALL_<KEY> or --set key=value.
   * Settings defined with `folder: true` can be overridden per folder; subfolders inherit.
   */
  settings: {
    define: (defs: SettingInput[]) => void;
    /** A key of any plugin or the core. With a folder, the value for tasks in that folder. */
    get: <T = unknown>(key: string, folderId?: string | null) => T;
  };

  /** The plugin's own key-value storage. */
  kv: {
    get: <T = unknown>(key: string) => T | undefined;
    set: (key: string, value: unknown) => void;
  };
}

export interface ServerPlugin {
  setup: (ctx: PluginContext) => void | Promise<void>;
}

export function definePlugin(setup: ServerPlugin["setup"]): ServerPlugin {
  return { setup };
}
