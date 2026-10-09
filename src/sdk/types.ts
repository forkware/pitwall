// Data shared by the server, the UI and plugins.

/** Plugin-owned data, keyed by plugin id: `meta["local-dir"] = { path }`. */
export type Meta = Record<string, unknown>;

export interface Folder {
  id: string;
  parentId: string | null;
  name: string;
  position: number;
  meta: Meta;
  /** Its own setting values; subfolders inherit them. Only settings defined with `folder: true`. */
  settings: Record<string, unknown>;
  createdAt: number;
}

export interface Task {
  id: string;
  folderId: string;
  title: string;
  body: string;
  status: string;
  position: number;
  meta: Meta;
  /** The directory its agents start in, set by a process (a git worktree, say); null: the folder's. */
  workspace: string | null;
  createdAt: number;
  updatedAt: number;
  /** When it went to the archive; null while it is in the tree. Archived tasks are read only. */
  archivedAt: number | null;
  /** Who sent it there: "user", "rule" (the folder's auto-archive), "folder" (its folder was deleted), "automation:<id>", or a plugin's id. */
  archivedBy: string | null;
  /** Never deleted from the archive by a rule. */
  keep: boolean;
  /** When it reached a status of the "done" category; null while it is not done. Auto-archiving counts from it. */
  doneAt: number | null;
}

/** The core sorts and filters by category; it knows nothing about the statuses themselves. */
export type StatusCategory = "open" | "active" | "done";

export type StatusColor = "gray" | "blue" | "amber" | "green" | "red" | "violet";

export interface StatusDef {
  id: string;
  label: string;
  color: StatusColor;
  category: StatusCategory;
  /** Plugin that registered it, or "core". */
  plugin: string;
}

/** "suspended": the app stopped while the agent ran; opening the session resumes it. */
export type SessionState = "running" | "exited" | "suspended";

export interface Session {
  id: string;
  taskId: string;
  provider: string;
  cwd: string;
  state: SessionState;
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
  /** The agent's own id for the conversation, which resumes it; null until the provider found it. */
  agentSessionId: string | null;
  /**
   * Why it ended, when it did not end by itself: "stopped" (the user or a plugin ended it), "gone" (its directory
   * was removed), or what the plugin that stopped it said. null when the agent exited by itself or is running.
   */
  exitReason: string | null;
  /** Running and printing: the agent is working. Waiting for the user, it prints nothing. */
  busy: boolean;
  /** When the agent last printed and the user last typed into it; null when it is not running. */
  lastOutputAt: number | null;
  lastInputAt: number | null;
  /** Quiet and showing a question to the user (a permission prompt), as its provider recognizes it. */
  asking: boolean;
  /** Quiet and waiting to go on by itself (a usage limit until it resets), as its provider recognizes it; busy too. */
  waiting: boolean;
}

/** Whether an ended session's agent can be brought back in its tab, and how. */
export interface Continuation {
  possible: boolean;
  /** In the same conversation; else a fresh one in the same directory. */
  resumes: boolean;
  /** Its directory was removed. */
  gone: boolean;
  /** What a plugin offers to bring the directory back: a string key for t(). */
  restore?: string;
}

/** What an agent can tell the app with `pitwall <name> [text]`. */
export interface SignalInfo {
  name: string;
  description: string;
  plugin: string;
}

export interface ProviderInfo {
  id: string;
  label: string;
  plugin: string;
  /** Whether its command was found in PATH. */
  available: boolean;
  /** It can answer once without a terminal (`claude -p`, `codex exec`). */
  exec: boolean;
}

export interface Permission {
  id: string;
  reason: string;
}

export interface PluginInfo {
  id: string;
  name: string;
  description: string;
  permissions: Permission[];
}

export interface AppInfo {
  name: string;
  version: string;
  /** Directory of the app's own source code: the user's fork. */
  root: string;
  /** Whether the app can restart its server by itself (it runs under `pnpm start`). */
  restartable: boolean;
}

export type SettingType = "string" | "number" | "boolean" | "select" | "json";

export interface SettingDef {
  /** "defaultProvider" for the core, "<plugin id>.<name>" for a plugin's. */
  key: string;
  label: string;
  description?: string;
  type: SettingType;
  /** The choices of a "select". */
  options?: { value: string; label: string }[];
  default?: unknown;
  /** Folders can override it for themselves and their subfolders. */
  folder?: boolean;
  /** Plugin that defined it, or "core". */
  plugin: string;
  /** The environment variable that sets it: PITWALL_<KEY>. */
  env: string;
}

/** Where an app value comes from, strongest first: cli, env, file, default. */
export type SettingSource = "cli" | "env" | "file" | "default";

export interface SettingValue {
  value: unknown;
  source: SettingSource;
}

/**
 * What a process step asks the user. The UI shows it with the task; the answer resumes the process.
 * A choice is answered with the id of an option, a form with an object of field id → its value (`FormValue`).
 */
export type UserRequest =
  | {
      kind: "choice";
      /** Names the question among the step's `questions`, so automations can answer it; "main" when omitted. */
      id?: string;
      title: string;
      body?: string;
      /**
       * `status`: the status this answer moves the task to. The status menu offers these options
       * while the process waits, so the process's manual transitions are its questions.
       */
      options: { id: string; label: string; primary?: boolean; status?: string }[];
    }
  | {
      kind: "form";
      id?: string;
      title: string;
      body?: string;
      fields: FormField[];
      submit?: string;
    };

/**
 * A field of a form. Without `options` it is text; with them the user picks one (or several with `multiple`),
 * and `other` adds "Other…" with a text of the user's own, which is then the value (or one of them).
 */
export interface FormField {
  id: string;
  label: string;
  multiline?: boolean;
  placeholder?: string;
  required?: boolean;
  options?: string[];
  multiple?: boolean;
  other?: boolean;
  /**
   * A likely answer: greyed in the empty text field with a Tab sign, or the options marked to pick with Tab.
   * It goes nowhere unless the user takes it.
   */
  suggestion?: FormValue;
}

/** Text, or the options picked: one string, or a list of them for `multiple`. */
export type FormValue = string | string[];

/** A step's parameter: a field of its card in the process editor, and what the step gets in `params`. */
export interface ParamDef {
  /** "text" is multiline; "prompt" is a text for an agent, with the task's values to insert. */
  type: "string" | "text" | "prompt" | "number" | "boolean" | "select";
  label: string;
  description?: string;
  placeholder?: string;
  /** A value, or `{ setting: "<key>" }`: that setting's value for the task's folder. */
  default?: unknown;
  /** The choices of a "select". */
  options?: { value: string; label: string }[];
  /** The process cannot run while it has no value. */
  required?: boolean;
}

/** A question a step asks the user, declared so the editor and automations know it before it is asked. */
export interface QuestionInfo {
  /** Matches the `id` of the `UserRequest` the step asks; "main" when the request has none. */
  id: string;
  kind: "choice" | "form";
  title: string;
  options?: { id: string; label: string; status?: string }[];
  fields?: { id: string; label: string; required?: boolean }[];
  /** Asked only sometimes ("when the tests fail 3 times"): not counted in "asks you N times". */
  when?: string;
  /** Asked inside a process run as a node: the node path in it ("ask", "sub/ask"). */
  node?: string;
  /** That inner node's step. */
  step?: string;
}

/** Who does a step's work: the user (it asks), an agent, or the app itself. */
export type StepRole = "you" | "agent" | "app";

export interface StepInfo {
  /** "<plugin id>.<name>". */
  id: string;
  label: string;
  description?: string;
  plugin: string;
  /** State keys it reads, "namespace.name"; a trailing "?" marks an optional one. */
  reads: string[];
  /** State keys it writes. */
  writes: string[];
  /** A lucide icon name in kebab case. */
  icon?: string;
  /** Where the step picker lists it: "you", "agent", "git", "github", "tests", or a plugin's own word. */
  group?: string;
  role: StepRole;
  /** State key → words for it: "git.branch" → "the task's branch". */
  labels: Record<string, string>;
  params: Record<string, ParamDef>;
  /** State key → its values the process can branch on → words for them. */
  outcomes: Record<string, Record<string, string>>;
  /** What it asks, with its parameters' defaults. */
  questions: QuestionInfo[];
  /** It changes the world outside the app (pushes, merges, posts): a trial run without consequences skips it. */
  sideEffects: boolean;
}

/** A field of what a process takes when it starts. */
export interface InputDef {
  type: "string" | "text";
  label: string;
  optional?: boolean;
}

/** Where a process goes after a node, when it branches: by one state key's value. */
export interface SwitchSpec {
  on: string;
  /** The key's value as text ("true", "ship") → the node it leads to. */
  cases: Record<string, string>;
  /** Where any other value leads; without it, another value fails the step. */
  else?: string;
}

/** A node of a process as data: a step, or another process run as one step. */
export interface NodeSpec {
  step?: string;
  /** Another process, run as this node: its questions ask the user, its statuses move the task. */
  process?: string;
  /** The inner process's input key → the key of this process it takes it from; by default the same key. */
  in?: Record<string, string>;
  /** The inner process's output key → the key of this process it is written to; by default the same key. */
  out?: Record<string, string>;
  /** The inner process copied in when saved, so later changes to it do not reach this one. */
  pin?: ProcessSpec;
  label?: string;
  params?: Record<string, unknown>;
  /** The task's status while this node runs. */
  status?: string;
  /** Skipped: shown in the recipe, but the process passes it by. */
  skip?: boolean;
}

/** `[from, to]`, `[from, { on, cases, else }]`; a code process's router shows as `[from, { targets }]`. */
export type EdgeSpec = [from: string, to: string] | [from: string, branch: SwitchSpec] | [from: string, router: { targets: string[] }];

/** A process as data: what a file in plugins/<id>/processes/ holds and the editor changes. */
export interface ProcessSpec {
  /** Without the plugin's prefix. */
  id: string;
  label: string;
  description?: string;
  icon?: string;
  hotkey?: string;
  /** The keys it takes when it starts; with labels, the fields an automation fills. */
  inputs?: string[] | Record<string, InputDef>;
  /** The keys a process that runs it as a node gets back. */
  outputs?: string[];
  /** In the order of the recipe. */
  nodes: Record<string, string | NodeSpec>;
  edges: EdgeSpec[];
  doneStatus?: string;
  /** Offered in "New process" as a start, not on its own. */
  template?: boolean;
  /** "<plugin>.<id>": this is the user's own version of that process, used in its place. */
  overrides?: string;
  /** The version of the original this one was made from: "the original changed" when it differs. */
  base?: string;
}

/** Why a process cannot run, for a person: a code the UI words and offers a fix for. */
export interface ProcessIssue {
  /**
   * noStep · noProcess · unmetRead (data.key, data.step, data.writers) · noStatus (data.status) · noEdge (data.to) ·
   * noStart · unreachable · noExit · selfCall (data.chain) · noParam (data.param) · noCase (data.on) · fileRouter
   */
  code: string;
  node?: string;
  data?: Record<string, unknown>;
  /** In English, for logs and the API. */
  message: string;
}

export interface ProcessNodeInfo {
  id: string;
  /** The step's id; for a node that runs another process, "". */
  step: string;
  process?: string;
  label: string;
  status?: string;
  role: StepRole;
  icon?: string;
  /** What the node asks: its step's questions, or the inner process's. */
  questions: QuestionInfo[];
  /** What it can end with, for its node's parameters: key → value → words. */
  outcomes: Record<string, Record<string, string>>;
  skip: boolean;
}

export interface ProcessInfo {
  /** "<plugin id>.<name>". */
  id: string;
  label: string;
  description?: string;
  plugin: string;
  /** A lucide icon name in kebab case ("bug", "git-branch") for its button; folders can pick another. */
  icon?: string;
  /** Keys that create a task with it in the folder in focus, e.g. "Alt+B"; folders can change them. */
  hotkey?: string;
  /** In the order they were declared; `status` is what the task shows while the node runs. */
  nodes: ProcessNodeInfo[];
  /** The status the task gets when the process reaches its end. */
  doneStatus: string;
  /** Why it cannot run: a missing step, a read nobody writes, an edge to nowhere. Empty when it can. */
  problems: string[];
  issues: ProcessIssue[];
  /** "file": plugins/<id>/processes/<name>.json, which the editor changes; "code": registered by a plugin. */
  source: "code" | "file";
  /** The file, for a file process. */
  file?: string;
  /** The process as data. A code process's routers show as `{ targets }`. */
  spec: ProcessSpec;
  /** It has no code routers: the editor can change it. */
  editable: boolean;
  /** The hash of its spec, for a file process; tasks keep the version they started with. */
  version: string | null;
  /** This is the user's own version of a plugin's process: the plugin's one, and whether it changed since. */
  original?: { plugin: string; spec: ProcessSpec; version: string | null; updated: boolean };
  template: boolean;
  inputs: { key: string; type: InputDef["type"]; label: string; optional: boolean }[];
  /** How many questions it asks the user, inner processes' included. */
  asks: number;
}

/** One step a task's process ran, for "Why is the task here?" and trial runs. */
export interface ProcessTraceEntry {
  seq: number;
  /** The node; inside an inner process, "outer/inner". */
  node: string;
  step: string;
  startedAt: number;
  endedAt: number | null;
  result: "running" | "done" | "asked" | "answered" | "failed" | "skipped";
  /** What it returned. */
  output: FlowStateView | null;
  /** The user's answer, when it asked. */
  answer: unknown;
  error: string | null;
}

/** Process state as JSON: "namespace.name" → value. */
export type FlowStateView = Record<string, unknown>;

/** How a task's process runs: a trial from the editor, without consequences, step by step. */
export interface ProcessRunOptions {
  trial?: boolean;
  /** Steps with side effects are skipped. */
  dryRun?: boolean;
  /** It asks before each step. */
  stepByStep?: boolean;
}

/** A saved version of a file process. */
export interface ProcessVersion {
  process: string;
  version: string;
  spec: ProcessSpec;
  at: number;
  note: string | null;
}

/** running: a step works · waiting: a step asked the user · failed: a step threw · done: it reached the end. */
export type ProcessRunState = "running" | "waiting" | "failed" | "done";

/** A task's process. A task has at most one, chosen when it starts. */
export interface ProcessRun {
  taskId: string;
  process: string;
  state: ProcessRunState;
  /** The node running, waiting or failed. */
  node: string | null;
  /** What the user is asked while waiting. */
  request: UserRequest | null;
  /** What the running step says it is doing, e.g. "Reading the repository"; null when it said nothing. */
  progress: string | null;
  error: string | null;
  startedAt: number;
  updatedAt: number;
  /** The version of the process it follows; null: the current one (a code process). */
  version: string | null;
  /** The nodes from the outer process in: ["develop", "test"] while an inner process's step runs. */
  path: string[];
  options: ProcessRunOptions;
}

/**
 * One of the processes a folder creates its tasks with: a button in the folder's row and a hotkey.
 * `icon` and `hotkey` override the process's own; a hotkey of "" means none.
 * The folder setting `taskProcesses` holds a list of these, in the order of the buttons.
 */
export interface FolderProcess {
  process: string;
  icon?: string;
  hotkey?: string;
}

/** An automation's answer to one question of its process. */
export interface AutomationAnswer {
  answer: string;
  /** Only when a key a step wrote has this value (as a branch compares it); otherwise the task waits. */
  when?: { key: string; value: string };
}

/** What makes an automation's tasks: a schedule, or a request to its webhook. */
export type AutomationTrigger =
  | {
      kind: "schedule";
      /** Five cron fields: "0 3 * * 1-5" is 03:00 on weekdays. */
      cron: string;
      /** IANA name, "Europe/Moscow". */
      timezone: string;
      /** A run that fell while the app was off: skipped, or made once when it starts. */
      missed: "skip" | "once";
    }
  | {
      kind: "webhook";
      /** How a request proves itself: the secret in the address, GitHub's signature, or a header with the secret. */
      verify: "url" | "github" | "header";
      /** Only requests that match make tasks: `payload.action == "opened" && payload.issue`. Empty: all. */
      filter?: string;
    };

/** What a user sets on an automation. */
export interface AutomationConfig {
  trigger: AutomationTrigger;
  /** The process its tasks follow; null: plain tasks. */
  process: string | null;
  /** Templates: {{date}}, {{time}}, {{datetime}}, {{automation}}, {{payload.issue.title}}. */
  title: string;
  body: string;
  /** Answers to the form the process's first step asks, by field id; templates too. */
  answers: Record<string, string>;
  /**
   * What to answer for the user when the process asks a question later, by "<node path>:<question id>": an option's
   * id, "stop" to end the task's process, or "wait" for the user (also what a question not here does).
   */
  questions: Record<string, AutomationAnswer>;
  /** The questions the user decided about here; one the process asks that is not among them is new. */
  seen: string[];
  /** Without a process: start the folder's agent with the task's title and description. */
  startAgent: boolean;
  /** While its last task is not done: skip the run, or make another task. */
  overlap: "skip" | "always";
  /** Where its tasks show in the tree: under its own node, among the folder's tasks, or nowhere. */
  view: "group" | "folder" | "hidden";
  /** Days after done before its task goes to the archive (0: at once); null: never; "folder": the folder's rule. */
  archiveAfter: number | null | "folder";
  /** Days in the archive before its task is deleted; null: never; "folder": the folder's rule. */
  deleteAfter: number | null | "folder";
  /** Keeps only its last N archived tasks; null: no limit. */
  keepRuns: number | null;
}

export type AutomationHow = "schedule" | "missed" | "manual" | "webhook";

/** What one trigger of an automation did. */
export interface AutomationRun {
  id: string;
  automationId: string;
  at: number;
  how: AutomationHow;
  /** The task it made, when it made one. */
  taskId: string | null;
  /**
   * created: it made a task · skipped: the last task is not done, the automation is paused, or the app was off ·
   * rejected: a webhook request did not prove itself or did not pass the filter · error: making the task failed.
   */
  result: "created" | "skipped" | "rejected" | "error";
  /** Why, for the UI: "previous", "paused", "app-off", "signature", "filter", or an error's text. */
  detail: string | null;
  /** The webhook's request body. */
  payload: unknown;
}

/** An automation's run with what its task is now, for the automation's page. */
export interface AutomationRunView extends AutomationRun {
  task: { title: string; status: string; archived: boolean; process: ProcessRunState | null } | null;
}

/** Makes tasks with a process in a folder, by a schedule or a webhook. */
export interface Automation extends AutomationConfig {
  id: string;
  folderId: string;
  name: string;
  /** Paused when false: the schedule does not fire, the webhook answers 503. */
  enabled: boolean;
  /** The webhook's secret: in its address, the key of GitHub's signature, or the header's value. */
  secret: string;
  createdAt: number;
  /** The schedule's next run; null for a webhook or a paused automation. */
  nextRun: number | null;
  lastRun: AutomationRun | null;
  /** Its last run failed, or the task it made has a failed process: shown in red. */
  failing: boolean;
  /** The last three webhook requests did not prove themselves: the secret may be wrong somewhere. */
  rejecting: boolean;
  /** The webhook's address on this server, without the host: "/hooks/<id>" or "/hooks/<id>/<secret>". */
  hookPath: string;
  /** The last body its webhook got, to pick fields for the templates from. */
  lastPayload: unknown;
}

/** An archived task as the archive lists it. */
export interface ArchivedTask extends Task {
  /** "Work / Client". */
  folderPath: string;
  /** Its folder was deleted; restoring the task brings the folder back. */
  folderDeleted: boolean;
  /** When a rule deletes it; null when none will. */
  deleteAt: number | null;
}

/** What the sidebar and the tree show of the archive. */
export interface ArchiveInfo {
  /** Archived tasks. */
  count: number;
  /** Archived tasks a rule deletes within 7 days. */
  dueSoon: number;
  /** Task id → when a rule archives it, for the done tasks a rule will archive. */
  archiveAt: Record<string, number>;
}

/** A task a rule deleted from the archive: only its name stays, in the archive's log. */
export interface Deletion {
  at: number;
  taskId: string;
  title: string;
  folder: string;
  /** "days": the folder's rule; "automation": its automation's; "runs": the automation keeps its last runs. */
  rule: string;
}

export interface AppState {
  app: AppInfo;
  folders: Folder[];
  tasks: Task[];
  statuses: StatusDef[];
  providers: ProviderInfo[];
  sessions: Session[];
  plugins: PluginInfo[];
  signals: SignalInfo[];
  settings: {
    defs: SettingDef[];
    values: Record<string, SettingValue>;
    /** The settings file the app values are saved to. */
    file: string;
  };
  processes: { defs: ProcessInfo[]; steps: StepInfo[]; runs: ProcessRun[] };
  archive: ArchiveInfo;
  automations: Automation[];
  /** A restart waits for the busy agents to finish; null when none was asked for. */
  restart: { pending: true } | null;
}

/** A write a plugin made, recorded by rule 7 of the manifesto. */
export interface AuditEntry {
  at: number;
  plugin: string;
  action: string;
  permission: string;
  /** False when the plugin did not declare the permission: an alarm. */
  declared: boolean;
}
