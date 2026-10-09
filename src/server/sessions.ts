// Agent sessions: CLI agents (claude, codex, ...) running in pseudo-terminals.
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { accessSync, appendFileSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import pty from "@lydell/node-pty";
import type { Db } from "./db.ts";
import type { EventBus } from "./events.ts";
import type { Settings } from "./settings.ts";
import { UserError, type Store } from "./store.ts";
import type { AgentProvider, CwdRestorer, RunControl, RunOptions, SignalDef, StartOptions, WorkspaceResolver } from "../sdk/server.ts";
import type { Continuation, ProviderInfo, Session, SignalInfo } from "../sdk/types.ts";

/** How much output a session keeps in memory for clients that attach later. */
const SCROLLBACK = 2 * 1024 * 1024;
/**
 * A working agent keeps redrawing its spinner and timer; one waiting for the user prints nothing.
 * So an agent that printed within this time is busy.
 */
export const BUSY_MS = 4000;

/**
 * An agent redraws its whole screen when its terminal is resized (Claude Code does). Output this soon after a resize
 * is that redraw, not work: counted as work, a restart's banner that resizes the terminal would keep the agent busy.
 */
export const REDRAW_MS = 1500;

/** How much of the end of the output counts as the agent's screen. */
const SCREEN = 6000;

interface Live {
  pty: pty.IPty;
  buffer: string;
  lastOutputAt: number;
  lastInputAt: number | null;
  busy: boolean;
  asking: boolean;
  waiting: boolean;
  /** What the agent's `pitwall` command proves itself with: one per run of the agent. */
  token: string;
  /** The terminal's size and when it last changed: output right after is a redraw. */
  size: string;
  resizedAt: number;
  /** Stopped by suspend(): it comes back when opened, instead of ending. */
  suspending?: boolean;
  /** Ended by kill(): why, kept with the session. */
  reason?: string;
}

type Row = Record<string, any>;

/** A `run()` in a terminal nobody sees: what its agent's `pitwall` does. */
interface Hidden {
  signal: (name: string, text: string) => Promise<string>;
}

/** What an agent run in a terminal nobody sees is told about talking to the app. */
const HIDDEN_RULES = `You run inside pitwall, in a terminal nobody watches. Talk to the app only with the \`pitwall\` command:
- \`pitwall answer "<your answer>"\` (or pipe a file into it): your answer. Nothing else you print reaches the user.
- \`pitwall ask "<question>"\`: ask the user something you cannot decide; wait, their answer is typed here.
- \`pitwall progress "<what you are doing>"\`: a short line the user sees while you work.`;

/** The last lines of an output, without terminal codes. */
const tailOf = (text: string) => stripAnsi(text).split("\n").slice(-40).join("\n");

const toSession = (r: Row, live?: Live): Session => ({
  id: r.id,
  taskId: r.task_id,
  provider: r.provider,
  cwd: r.cwd,
  state: r.state,
  exitCode: r.exit_code,
  startedAt: r.started_at,
  endedAt: r.ended_at,
  agentSessionId: r.agent_session_id ?? null,
  exitReason: r.exit_reason ?? null,
  busy: live?.busy ?? false,
  lastOutputAt: live ? live.lastOutputAt || null : null,
  lastInputAt: live?.lastInputAt ?? null,
  asking: live?.asking ?? false,
  waiting: live?.waiting ?? false,
});

export class Sessions {
  private providers = new Map<string, AgentProvider & { plugin: string }>();
  private resolvers: WorkspaceResolver[] = [];
  private restorers: CwdRestorer[] = [];
  private live = new Map<string, Live>();
  private signals = new Map<string, SignalDef & { plugin: string }>();
  /** Agents run for `run()` in a terminal nobody sees: not sessions of a task, not in the database. */
  private hidden = new Map<string, Hidden>();
  /** Where agents reach the app with `pitwall`: the HTTP server's address, once it listens. */
  agentUrl: string | undefined;
  /** The directory with the `pitwall` command, put first in agents' PATH. */
  agentBin: string | undefined;
  /** Set when the app shuts down; output and exits after that are dropped. */
  private closed = false;
  private db: Db;
  private events: EventBus;
  private store: Store;
  private settings: Settings;
  private dataDir: string;
  private timer: ReturnType<typeof setInterval>;

  constructor(db: Db, events: EventBus, store: Store, settings: Settings, dataDir: string) {
    this.db = db;
    this.events = events;
    this.store = store;
    this.settings = settings;
    this.dataDir = dataDir;
    mkdirSync(join(dataDir, "sessions"), { recursive: true });
    // Sessions that were running when the app stopped went with it; opening them resumes them.
    db.prepare("UPDATE sessions SET state = 'suspended', ended_at = ? WHERE state = 'running'").run(Date.now());
    this.timer = setInterval(() => this.tick(), 1000);
    this.timer.unref();
    events.on("task.deleting", (task) => {
      for (const s of this.list(task.id)) this.remove(s.id);
    });
    // An archived task's agents end; its sessions stay to be read, and continue after it is restored.
    events.on("task.archived", (task) => {
      for (const s of this.list(task.id)) {
        if (s.state === "running") this.kill(s.id, "archived");
        else if (s.state === "suspended") {
          this.db.prepare("UPDATE sessions SET state = 'exited', exit_reason = 'archived' WHERE id = ?").run(s.id);
          this.events.emit("session.exited", { ...this.get(s.id), taskId: task.id });
        }
      }
    });
  }

  registerProvider(plugin: string, provider: AgentProvider): void {
    this.providers.set(provider.id, { ...provider, plugin });
  }

  registerResolver(resolver: WorkspaceResolver): void {
    this.resolvers.push(resolver);
  }

  registerRestorer(restorer: CwdRestorer): void {
    this.restorers.push(restorer);
  }

  providerInfo(): ProviderInfo[] {
    return [...this.providers.values()].map((p) => ({
      id: p.id,
      label: p.label,
      plugin: p.plugin,
      available: findExecutable(p.command) !== undefined,
      exec: !!p.exec,
    }));
  }

  list(taskId?: string): Session[] {
    const rows = taskId
      ? this.db.prepare("SELECT * FROM sessions WHERE task_id = ? ORDER BY started_at").all(taskId)
      : this.db.prepare("SELECT * FROM sessions ORDER BY started_at").all();
    return rows.map((r) => toSession(r, this.live.get(r.id as string)));
  }

  get(id: string): Session | undefined {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id);
    return row ? toSession(row, this.live.get(id)) : undefined;
  }

  /**
   * Running sessions whose agents are working rather than waiting for the user. One waiting for its usage limit to
   * reset is left out: a restart or a stop need not wait hours for it, and it resumes after.
   */
  busy(): Session[] {
    return [...this.live.entries()].filter(([, l]) => l.busy && !l.waiting).flatMap(([id]) => this.get(id) ?? []);
  }

  start(taskId: string, options: StartOptions = {}): Session {
    const task = this.store.task(taskId);
    if (!task) throw new UserError(`No task ${taskId}`);
    if (task.archivedAt) throw new UserError("The task is in the archive: restore it first");
    const preferred = options.provider ?? this.settings.get<string>("defaultProvider", task.folderId);
    // The default may name an agent that is not installed as a plugin; then the first one there is.
    const providerId = options.provider ?? (this.providers.has(preferred) ? preferred : this.providers.keys().next().value);
    const provider = providerId ? this.providers.get(providerId) : undefined;
    if (!provider) throw new UserError(providerId ? `No agent provider ${providerId}` : "No agent providers installed");
    const command = findExecutable(provider.command);
    if (!command) throw new UserError(`${provider.label} is not installed: \`${provider.command}\` is not in PATH`);

    const cwd = this.workspace(taskId);
    const session: Session = {
      id: randomUUID(),
      taskId,
      provider: provider.id,
      cwd,
      state: "running",
      exitCode: null,
      startedAt: Date.now(),
      endedAt: null,
      agentSessionId: null,
      exitReason: null,
      busy: false,
      lastOutputAt: null,
      lastInputAt: null,
      asking: false,
      waiting: false,
    };
    this.spawn(session, command, provider, provider.args?.({ prompt: options.prompt, sessionId: session.id }) ?? []);
    this.db
      .prepare(
        "INSERT INTO sessions (id, task_id, provider, cwd, state, started_at) VALUES (?, ?, ?, ?, 'running', ?)",
      )
      .run(session.id, taskId, provider.id, cwd, session.startedAt);
    this.events.emit("session.started", session);
    return session;
  }

  /**
   * Starts a suspended session's agent again in the same tab: in the same conversation when the provider
   * can resume it, afresh otherwise. Does nothing for other sessions.
   */
  resume(id: string): void {
    const session = this.get(id);
    if (!session || session.state !== "suspended" || this.live.has(id)) return;
    if (this.store.task(session.taskId)?.archivedAt) return;
    const provider = this.providers.get(session.provider);
    const command = provider && findExecutable(provider.command);
    if (!provider || !command) return;
    if (!existsSync(session.cwd)) {
      // Its worktree was removed, say: the agent cannot start there, and elsewhere its conversation is not found.
      const note = `\r\n[The directory ${session.cwd} is gone.]\r\n`;
      appendFileSync(this.logFile(id), note);
      this.db.prepare("UPDATE sessions SET state = 'exited', exit_reason = 'gone' WHERE id = ?").run(id);
      this.events.emit("session.output", { id, data: note });
      this.events.emit("session.exited", { ...this.get(id), taskId: session.taskId });
      return;
    }
    try {
      this.revive(session, provider, command);
    } catch (error) {
      // The session stays as it ended.
      console.error(`Could not resume session ${id}:`, error);
      this.db.prepare("UPDATE sessions SET state = 'exited' WHERE id = ?").run(id);
      this.events.emit("session.exited", this.get(id));
    }
  }

  /** Whether continue() can bring an ended or suspended session's agent back, and how. */
  continuation(id: string): Continuation {
    const session = this.get(id);
    const none: Continuation = { possible: false, resumes: false, gone: false };
    if (!session || session.state === "running" || this.live.has(id)) return none;
    const provider = this.providers.get(session.provider);
    if (!provider || !findExecutable(provider.command)) return none;
    const gone = !existsSync(session.cwd);
    const restore = gone ? this.restorerFor(session)?.offer : undefined;
    return {
      possible: !gone || restore !== undefined,
      resumes: this.findAgentSession(session) !== undefined,
      gone,
      ...(restore ? { restore } : {}),
    };
  }

  /**
   * Starts an ended (or suspended) session's agent again in the same tab, in the same conversation when the
   * provider can resume it. A directory that is gone is restored first by a plugin that can (a removed worktree).
   */
  continue(id: string): Session {
    const session = this.get(id);
    if (!session) throw new UserError(`No session ${id}`);
    if (session.state === "running" || this.live.has(id)) return session;
    if (this.store.task(session.taskId)?.archivedAt) throw new UserError("The task is in the archive: restore it first");
    const provider = this.providers.get(session.provider);
    if (!provider) throw new UserError(`No agent provider ${session.provider}`);
    const command = findExecutable(provider.command);
    if (!command) throw new UserError(`${provider.label} is not installed: \`${provider.command}\` is not in PATH`);
    if (!existsSync(session.cwd)) {
      const found = this.restorerFor(session);
      if (!found) throw new UserError(`The directory ${session.cwd} is gone`);
      const dir = found.restorer.restore(session, this.store.task(session.taskId)!);
      if (!existsSync(dir)) throw new UserError(`The directory ${dir} was not restored`);
      if (dir !== session.cwd) {
        this.db.prepare("UPDATE sessions SET cwd = ? WHERE id = ?").run(dir, id);
        session.cwd = dir;
      }
    }
    this.revive(session, provider, command);
    return this.get(id)!;
  }

  /** The first restorer that offers to bring the session's directory back. */
  private restorerFor(session: Session): { restorer: CwdRestorer; offer: string } | undefined {
    const task = this.store.task(session.taskId);
    if (!task) return undefined;
    for (const restorer of this.restorers) {
      try {
        const offer = restorer.offer(session, task);
        if (offer) return { restorer, offer };
      } catch (error) {
        console.error(`Restoring ${session.cwd} failed:`, error);
      }
    }
    return undefined;
  }

  /** Runs the session's agent again: in its conversation when the provider finds it, afresh otherwise. */
  private revive(session: Session, provider: AgentProvider, command: string): void {
    const agentSessionId = this.findAgentSession(session);
    const args = agentSessionId
      ? provider.resume!.args(agentSessionId)
      : (provider.args?.({ sessionId: session.id }) ?? []);
    const live = this.spawn(session, command, provider, args);
    live.buffer = this.scrollbackFromLog(session.id);
    this.db
      .prepare("UPDATE sessions SET state = 'running', exit_code = NULL, ended_at = NULL, exit_reason = NULL WHERE id = ?")
      .run(session.id);
    this.events.emit("session.resumed", this.get(session.id));
  }

  private spawn(session: Session, command: string, provider: AgentProvider, args: string[]): Live {
    const token = randomBytes(24).toString("hex");
    const channel: Record<string, string> = this.agentUrl ? { PITWALL_AGENT_URL: this.agentUrl, PITWALL_AGENT_TOKEN: token } : {};
    if (this.agentBin) channel.PATH = [this.agentBin, process.env.PATH ?? ""].join(delimiter);
    const proc = pty.spawn(command, args, {
      name: "xterm-256color",
      cols: 120,
      rows: 32,
      cwd: session.cwd,
      env: {
        ...process.env,
        ...provider.env,
        ...channel,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
      } as Record<string, string>,
    });
    const live: Live = {
      pty: proc,
      buffer: "",
      lastOutputAt: 0,
      lastInputAt: null,
      busy: false,
      asking: false,
      waiting: false,
      token,
      size: "120x32",
      resizedAt: 0,
    };
    this.live.set(session.id, live);
    const log = this.logFile(session.id);
    proc.onData((data) => {
      if (this.closed) return;
      live.buffer = (live.buffer + data).slice(-SCROLLBACK);
      const now = Date.now();
      if (now - live.resizedAt >= REDRAW_MS) live.lastOutputAt = now;
      appendFileSync(log, data);
      this.events.emit("session.output", { id: session.id, data });
    });
    proc.onExit(({ exitCode }) => {
      if (this.live.get(session.id) === live) this.live.delete(session.id);
      if (this.closed || !this.get(session.id)) return;
      if (live.suspending) {
        this.db.prepare("UPDATE sessions SET state = 'suspended', ended_at = ? WHERE id = ?").run(Date.now(), session.id);
        this.events.emit("session.suspended", this.get(session.id));
        return;
      }
      this.db
        .prepare("UPDATE sessions SET state = 'exited', exit_code = ?, ended_at = ?, exit_reason = ? WHERE id = ?")
        .run(exitCode, Date.now(), live.reason ?? null, session.id);
      this.events.emit("session.exited", { ...this.get(session.id), taskId: session.taskId });
    });
    return live;
  }

  /** The agent's id for the session's conversation, asked of the provider until it knows one, then kept. */
  private findAgentSession(session: Session): string | undefined {
    const provider = this.providers.get(session.provider);
    if (!provider?.resume) return undefined;
    if (session.agentSessionId) return session.agentSessionId;
    const rows = this.db
      .prepare("SELECT agent_session_id FROM sessions WHERE agent_session_id IS NOT NULL AND id != ?")
      .all(session.id) as { agent_session_id: string }[];
    let found: string | undefined;
    try {
      found = provider.resume.find(session, new Set(rows.map((r) => r.agent_session_id)));
    } catch (error) {
      console.error(`${provider.label}: finding the session of ${session.id} failed:`, error);
    }
    if (found) this.db.prepare("UPDATE sessions SET agent_session_id = ? WHERE id = ?").run(found, session.id);
    return found;
  }

  /** Each second: who is busy now, who asks the user, and the agent ids not found yet. */
  private tick(): void {
    const now = Date.now();
    for (const [id, live] of this.live) {
      if (this.hidden.has(id)) continue;
      const session = this.get(id);
      const provider = this.providers.get(session?.provider ?? "");
      let busy = now - live.lastOutputAt < BUSY_MS;
      let asking = false;
      let waiting = false;
      if (!busy && (provider?.waits || provider?.asks)) {
        const screen = this.screen(id);
        try {
          waiting = !!provider.waits?.(screen);
        } catch {}
        try {
          if (!waiting) asking = !!provider.asks?.(screen);
        } catch {}
      }
      // Waiting to go on by itself (a usage limit) is work, not a pause.
      busy ||= waiting;
      if (busy !== live.busy || asking !== live.asking || waiting !== live.waiting) {
        live.busy = busy;
        live.asking = asking;
        live.waiting = waiting;
        this.events.emit("session.activity", { id, taskId: session?.taskId, busy, asking, waiting });
      }
      if (session && !session.agentSessionId) this.findAgentSession(session);
    }
  }

  /** The end of the agent's output with the terminal's control sequences taken out. */
  screen(id: string): string {
    return stripAnsi(this.scrollback(id).slice(-SCREEN));
  }

  /** What the agent printed, as plain text in lines: the end of the session's log (see sessionLogText). */
  log(id: string): string {
    try {
      return sessionLogText(readFileSync(this.logFile(id), "utf8").slice(-4 * 1024 * 1024));
    } catch {
      return "";
    }
  }

  /** Output so far, for a client that attaches now. */
  scrollback(id: string): string {
    const live = this.live.get(id);
    if (live) return live.buffer;
    return this.scrollbackFromLog(id);
  }

  private scrollbackFromLog(id: string): string {
    try {
      return readFileSync(this.logFile(id), "utf8").slice(-SCROLLBACK);
    } catch {
      return "";
    }
  }

  /** What the user types into the agent. */
  write(id: string, data: string): void {
    const live = this.live.get(id);
    if (!live) return;
    live.lastInputAt = Date.now();
    live.pty.write(data);
  }

  /** A message from the app: pasted as a whole, so newlines do not send it early, then Enter. */
  send(id: string, text: string): void {
    const live = this.live.get(id);
    if (!live) throw new UserError("The agent is not running");
    live.pty.write(`\x1b[200~${text}\x1b[201~`);
    setTimeout(() => this.live.get(id) === live && live.pty.write("\r"), 200);
  }

  // What agents tell the app with `pitwall`

  registerSignal(plugin: string, def: SignalDef): void {
    this.signals.set(def.name, { ...def, plugin });
  }

  signalInfo(): SignalInfo[] {
    return [...this.signals.values()].map((s) => ({ name: s.name, description: s.description, plugin: s.plugin }));
  }

  /** The running session whose agent was given this token. */
  byToken(token: string): Session | undefined {
    for (const [id, live] of this.live) if (live.token === token && !this.hidden.has(id)) return this.get(id);
    return undefined;
  }

  /**
   * Handles `pitwall <name> [text]` from the agent with this token, in a task's session or in a `run()`'s
   * hidden one. Undefined when no agent has the token.
   */
  async signalByToken(token: string, name: string, text: string): Promise<string | undefined> {
    for (const [id, live] of this.live) {
      if (live.token !== token) continue;
      const hidden = this.hidden.get(id);
      if (hidden) return hidden.signal(name, text);
      const session = this.get(id);
      return session ? this.signal(session, name, text) : undefined;
    }
    return undefined;
  }

  /** Handles `pitwall <name> [text]` from the agent of a session; returns what to print to it. */
  async signal(session: Session, name: string, text: string): Promise<string> {
    if (!name || name === "help") {
      const list = [...this.signals.values()].map((s) => `  pitwall ${s.name.padEnd(8)} ${s.description}`);
      return list.length ? `Tell the app about this task:\n${list.join("\n")}` : "Nothing to tell the app here.";
    }
    const def = this.signals.get(name);
    if (!def) throw new UserError(`Unknown: ${name}. Known: ${[...this.signals.keys()].join(", ") || "none"}`);
    const task = this.store.task(session.taskId);
    if (!task) throw new UserError("The task is gone");
    const reply = await def.handler({ task, session, text });
    this.events.emit("agent.signal", { sessionId: session.id, taskId: task.id, name, text });
    return reply || "ok";
  }

  /**
   * Runs an agent once and resolves to its answer: without a terminal (its provider's `exec`), or with
   * `fallback: "session"` in a terminal nobody sees, when it has no `exec` or that run failed.
   */
  async run(prompt: string, options: RunOptions = {}): Promise<string> {
    const preferred = options.provider ?? this.settings.get<string>("defaultProvider", options.folderId ?? null);
    const wanted = this.providers.get(preferred);
    if (options.fallback === "session" && wanted && findExecutable(wanted.command)) {
      if (!wanted.exec) return this.runHidden(wanted, prompt, options);
      try {
        return await this.runExec(wanted, prompt, options);
      } catch (error) {
        if ((error as { stopped?: boolean }).stopped) throw error;
        console.warn(`${wanted.label} without a terminal failed, trying in a terminal:`, (error as Error).message);
        return this.runHidden(wanted, prompt, options);
      }
    }
    const usable = [preferred, ...this.providers.keys()].map((id) => this.providers.get(id)).filter((p) => p?.exec);
    const provider = options.provider ? usable.find((p) => p!.id === options.provider) : usable[0];
    if (!provider) throw new UserError(`No agent can run without a terminal${options.provider ? `: ${options.provider}` : ""}`);
    return this.runExec(provider, prompt, options);
  }

  private async runExec(provider: AgentProvider, prompt: string, options: RunOptions): Promise<string> {
    const command = findExecutable(provider.command);
    if (!command) throw new UserError(`${provider.label} is not installed: \`${provider.command}\` is not in PATH`);
    const dir = mkdtempSync(join(tmpdir(), "agent-run-"));
    const outputFile = join(dir, "answer.txt");
    let deadline = Date.now() + (options.timeoutMs ?? 5 * 60_000);
    let output = "";
    let stopped = false;
    try {
      const stdout = await new Promise<string>((resolve, reject) => {
        const child = execFile(
          command,
          provider.exec!({ prompt, outputFile }),
          { cwd: options.cwd ?? dir, env: { ...process.env, ...provider.env }, maxBuffer: 16 * 1024 * 1024 },
          (error, out, err) => {
            clearInterval(clock);
            if (stopped) return reject(Object.assign(new Error("Stopped"), { stopped: true, screen: tailOf(output) }));
            if (error) return reject(Object.assign(new Error(`${provider.label} failed: ${(err || error.message).trim().slice(-2000)}`), { screen: tailOf(output) }));
            resolve(out);
          },
        );
        child.stdout?.on("data", (d) => (output = (output + d).slice(-SCREEN)));
        child.stderr?.on("data", (d) => (output = (output + d).slice(-SCREEN)));
        child.stdin?.end();
        const clock = setInterval(() => {
          if (Date.now() < deadline) return;
          clearInterval(clock);
          child.kill();
          reject(Object.assign(new Error(`${provider.label} did not answer in time`), { timeout: true, screen: tailOf(output) }));
        }, 500);
        clock.unref();
        options.onStart?.({
          mode: "exec",
          sessionId: null,
          provider: provider.id,
          reply: () => {
            throw new UserError("This agent runs without a terminal: it cannot be answered");
          },
          ask: () => Promise.reject(new UserError("This agent runs without a terminal: start a new run")),
          extend: (ms) => void (deadline += ms),
          stop: () => {
            stopped = true;
            child.kill();
          },
          screen: () => tailOf(output),
        });
      });
      const written = existsSync(outputFile) ? readFileSync(outputFile, "utf8") : "";
      return (written.trim() ? written : stdout).trim();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** The agent in a terminal nobody sees; its answer comes with `pitwall answer`. */
  private runHidden(provider: AgentProvider & { plugin: string }, prompt: string, options: RunOptions): Promise<string> {
    const command = findExecutable(provider.command)!;
    const id = `run-${randomUUID()}`;
    const scratch = options.cwd ? undefined : mkdtempSync(join(tmpdir(), "agent-run-"));
    const session: Session = {
      id,
      taskId: "",
      provider: provider.id,
      cwd: options.cwd ?? scratch!,
      state: "running",
      exitCode: null,
      startedAt: Date.now(),
      endedAt: null,
      agentSessionId: null,
      exitReason: null,
      busy: false,
      lastOutputAt: null,
      lastInputAt: null,
      asking: false,
      waiting: false,
    };
    const full = `${prompt}\n\n${HIDDEN_RULES}`;
    const live = this.spawn(session, command, provider, provider.args?.({ prompt: full, sessionId: id }) ?? []);
    const started = Date.now();
    let deadline = started + (options.timeoutMs ?? 5 * 60_000);
    let lastSignal = started;
    let waiting: { resolve: (text: string) => void; reject: (error: Error) => void } | null = null;
    let ended = false;

    const end = (error?: Error) => {
      if (ended) return;
      ended = true;
      clearInterval(clock);
      this.hidden.delete(id);
      if (this.live.get(id) === live) live.pty.kill();
      this.live.delete(id);
      if (error) waiting?.reject(Object.assign(error, { screen: this.screenOf(live) }));
      waiting = null;
      setTimeout(() => {
        rmSync(this.logFile(id), { force: true });
        if (scratch) rmSync(scratch, { recursive: true, force: true });
      }, 1000).unref();
    };
    const next = () =>
      new Promise<string>((resolve, reject) => {
        if (ended) return reject(new UserError("The agent has ended"));
        waiting = { resolve, reject };
      });
    live.pty.onExit(() => end(new Error(`${provider.label} ended without an answer`)));
    const clock = setInterval(() => {
      const now = Date.now();
      if (now >= deadline) return end(Object.assign(new Error(`${provider.label} did not answer in time`), { timeout: true }));
      let asking = false;
      let waits = false;
      if (now - live.lastOutputAt >= BUSY_MS && (provider.waits || provider.asks)) {
        const screen = this.screenOf(live);
        try {
          waits = !!provider.waits?.(screen);
        } catch {}
        try {
          if (!waits) asking = !!provider.asks?.(screen);
        } catch {}
      }
      const silentFor = asking || waits ? 0 : now - Math.max(live.lastOutputAt, lastSignal, started);
      options.onActivity?.({ asking, silentFor, deadline });
    }, 1000);
    clock.unref();

    this.hidden.set(id, {
      signal: async (name, text) => {
        lastSignal = Date.now();
        if (name === "answer") {
          if (!text.trim()) throw new UserError("Give the answer as text or on stdin");
          const w = waiting;
          waiting = null;
          w?.resolve(text.trim());
          if (!options.keep) setTimeout(() => end(), 500);
          return "The app has your answer. Wait here: the user may ask for more.";
        }
        if (name === "ask") {
          if (!text.trim()) throw new UserError("Give the question");
          options.onAsk?.(text.trim());
          return "The user sees your question; their answer will be typed here. Wait for it.";
        }
        if (name === "progress") {
          options.onProgress?.(text.trim());
          return "ok";
        }
        return HIDDEN_RULES;
      },
    });
    const control: RunControl = {
      mode: "session",
      sessionId: id,
      provider: provider.id,
      reply: (text) => {
        lastSignal = Date.now();
        this.send(id, text);
      },
      ask: (text) => {
        const answer = next();
        lastSignal = Date.now();
        deadline = Math.max(deadline, Date.now() + (options.timeoutMs ?? 5 * 60_000));
        this.send(id, text);
        return answer;
      },
      extend: (ms) => void (deadline += ms),
      stop: () => end(Object.assign(new Error("Stopped"), { stopped: true })),
      screen: () => this.screenOf(live),
    };
    const first = next();
    options.onStart?.(control);
    return first;
  }

  private screenOf(live: Live): string {
    return stripAnsi(live.buffer.slice(-SCREEN));
  }

  resize(id: string, cols: number, rows: number): void {
    const live = this.live.get(id);
    if (!live || !(cols > 0 && rows > 0)) return;
    const size = `${Math.floor(cols)}x${Math.floor(rows)}`;
    if (size === live.size) return;
    live.size = size;
    live.resizedAt = Date.now();
    live.pty.resize(Math.floor(cols), Math.floor(rows));
  }

  /** Ends the agent; `reason` stays with the session, to tell the user why it ended. */
  kill(id: string, reason = "stopped"): void {
    const live = this.live.get(id);
    if (!live) return;
    live.reason = reason;
    live.pty.kill();
  }

  /** Stops the agent like the app's restart does: opening the session resumes its conversation. */
  suspend(id: string): void {
    const live = this.live.get(id);
    if (!live) return;
    // Its id is needed to resume; look once more before the agent is gone.
    const session = this.get(id);
    if (session) this.findAgentSession(session);
    live.suspending = true;
    live.pty.kill();
  }

  /** Stops the session and forgets it with its output. */
  remove(id: string): void {
    const session = this.get(id);
    this.kill(id);
    this.live.delete(id);
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
    rmSync(this.logFile(id), { force: true });
    if (session) this.events.emit("session.removed", session);
  }

  stopAll(): void {
    this.closed = true;
    clearInterval(this.timer);
    for (const id of this.live.keys()) this.kill(id);
  }

  /** The directory the resolvers give the task's folder, whatever the task's own workspace is. */
  ofFolder(taskId: string): string | undefined {
    const task = this.store.task(taskId);
    if (!task) return undefined;
    const folders = this.store.chain(task.folderId);
    for (const resolve of this.resolvers) {
      const dir = resolve(task, folders);
      if (dir) return dir;
    }
    return undefined;
  }

  private workspace(taskId: string): string {
    const task = this.store.task(taskId)!;
    if (task.workspace && existsSync(task.workspace)) return task.workspace;
    const dir = this.ofFolder(taskId);
    if (dir) return dir;
    const scratch = join(this.dataDir, "workspaces", taskId);
    mkdirSync(scratch, { recursive: true });
    return scratch;
  }

  private logFile(id: string): string {
    return join(this.dataDir, "sessions", `${id}.log`);
  }
}

/** Full path of an executable in PATH, honouring PATHEXT on Windows. */
export function findExecutable(command: string): string | undefined {
  const exts = process.platform === "win32" ? ["", ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")] : [""];
  const dirs = command.includes("/") || command.includes("\\") ? [""] : (process.env.PATH ?? "").split(delimiter);
  for (const dir of dirs) {
    for (const ext of exts) {
      const file = dir ? join(dir, command + ext) : command + ext;
      try {
        accessSync(file, constants.X_OK);
        if (statSync(file).isFile()) return file;
      } catch {}
    }
  }
  return undefined;
}

/** How much of a session's log the archived task's page shows: a browser lays out more only slowly. */
export const LOG_TEXT_MAX = 256 * 1024;

/**
 * A session's log as text to read, in lines, at most LOG_TEXT_MAX of its end. Agents' interfaces move the cursor
 * to the next row (\r, ESC[1B, ESC[row;colH) instead of printing newlines; without breaks there, a long session
 * becomes one line of megabytes, and the page that prints it hangs (#45).
 */
export function sessionLogText(raw: string): string {
  const text = stripAnsi(
    raw
      .replace(/\x1b\[[0-9;]*[BEFHfd]/g, "\n") // moves to another row
      .replace(/\r(?!\n)/g, "\n"),
  )
    .replace(/ +\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
  if (text.length <= LOG_TEXT_MAX) return text;
  const end = text.slice(-LOG_TEXT_MAX);
  return end.slice(end.indexOf("\n") + 1);
}

/** Text without terminal control sequences: what a person reads on the screen, roughly. */
export function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "") // OSC: titles, links
    .replace(/\x1b\[[0-9;?<=>]*[ -/]*[@-~]/g, " ") // CSI: colors, cursor moves (a move may stand for a space)
    .replace(/\x1b[()*+][0-9A-Za-z]/g, "") // character sets
    .replace(/\x1b[@-Z\\-_78=>]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
    .replace(/[ \t]+/g, " ");
}
