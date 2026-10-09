// Talks to the core over HTTP and one WebSocket, and keeps the UI state.
import { useRef, useSyncExternalStore } from "react";
import type { AppState } from "../sdk/types.ts";
import { takeStash } from "./reload.ts";

/** What the main panel shows. */
export type Selection =
  | { kind: "task"; id: string }
  | { kind: "folder"; id: string }
  | { kind: "settings" }
  /** The archive: all of it, or one folder's with its subfolders. */
  | { kind: "archive"; folderId?: string }
  /** An archived task, read only. */
  | { kind: "archived"; id: string }
  | { kind: "automations" }
  | { kind: "automation"; id: string }
  /** A page a plugin declared in `defineUiPlugin({ pages })`. */
  | { kind: "page"; plugin: string; page: string; params?: Record<string, unknown> };

/** The tabs of a folder's page. */
export type FolderTab = "tasks" | "automations" | "settings";

export interface UiState {
  data: AppState | null;
  selection: Selection | null;
  /** Folder id → collapsed. */
  collapsed: Record<string, boolean>;
  connected: boolean;
  /** The server runs older code than is on disk: restart the app. */
  serverStale: boolean;
  /** Id of the folder or task being renamed in the tree. */
  renaming: string | null;
  /** Tasks picked in the tree with Ctrl or Shift: shortcuts and the sidebar's bar act on all of them. */
  picked: string[];
  /** Folder id → its "Done" group is open; an automation's node too, by "automation:<id>". */
  opened: Record<string, boolean>;
  folderTab: FolderTab;
  /** The task's details panel: the tab it shows, or null while it is closed. */
  details: DetailsTab | null;
  /** The tab the details panel opens on next. */
  detailsTab: DetailsTab;
  /** A step's output shown in place of the task's terminal, read only; Esc takes it away. */
  output: { taskId: string; title: string; text: string } | null;
}

export type DetailsTab = "description" | "process" | "environment";

// After a reload by the app, the page draws what it showed before while the fresh state loads.
const stashed = typeof sessionStorage === "undefined" ? null : takeStash<AppState>(sessionStorage);
const saved = load<Partial<UiState> & { selectedTaskId?: string }>("agent.ui", {});
let state: UiState = {
  data: stashed,
  // Before folders could be selected, only the task was saved.
  selection: saved.selection ?? (saved.selectedTaskId ? { kind: "task", id: saved.selectedTaskId } : null),
  collapsed: saved.collapsed ?? {},
  // A page that was connected a moment ago does not show the "disconnected" bar while its socket opens.
  connected: stashed !== null,
  serverStale: false,
  renaming: null,
  picked: [],
  opened: saved.opened ?? {},
  folderTab: saved.folderTab ?? "tasks",
  details: saved.details ?? null,
  detailsTab: saved.detailsTab ?? "description",
  output: null,
};
const listeners = new Set<() => void>();

export function getState(): UiState {
  return state;
}

export function setState(patch: Partial<UiState>): void {
  state = { ...state, ...patch };
  save("agent.ui", {
    selection: state.selection,
    collapsed: state.collapsed,
    opened: state.opened,
    folderTab: state.folderTab,
    details: state.details,
    detailsTab: state.detailsTab,
  });
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Subscribes to part of the state. Results equal item by item count as unchanged. */
export function useUi<T>(select: (s: UiState) => T): T {
  const last = useRef<T>(undefined as T);
  return useSyncExternalStore(subscribe, () => {
    const next = select(state);
    if (!shallowEqual(next, last.current)) last.current = next;
    return last.current;
  });
}

function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.is((a as any)[k], (b as any)[k]));
}

// HTTP

export class ApiError extends Error {}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(json?.error ?? `${res.status} ${res.statusText}`);
  return json as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body: unknown = {}) => request<T>("POST", path, body),
  patch: <T>(path: string, body: unknown) => request<T>("PATCH", path, body),
  put: <T>(path: string, body: unknown) => request<T>("PUT", path, body),
  del: <T>(path: string) => request<T>("DELETE", path),
};

/** Calls a procedure a plugin registered with ctx.rpc.handle. */
export function rpc<T = unknown>(plugin: string, name: string, input: unknown = {}): Promise<T> {
  return api.post<T>(`/api/plugins/${plugin}/rpc/${name}`, input);
}

export async function refresh(): Promise<void> {
  const data = withDefaults(await api.get<AppState>("/api/state"));
  // A deleted task or folder is no longer selected.
  const { selection } = state;
  const exists = (() => {
    if (!selection) return true;
    switch (selection.kind) {
      case "task":
        return data.tasks.some((x) => x.id === selection.id);
      case "folder":
        return data.folders.some((x) => x.id === selection.id);
      case "automation":
        return data.automations.some((x) => x.id === selection.id);
      case "archive":
        return !selection.folderId || data.folders.some((x) => x.id === selection.folderId);
      default:
        return true;
    }
  })();
  // A task that went to the archive shows there, read only; a picked task that left the tree is no longer picked.
  const archived = selection?.kind === "task" && !exists && state.data?.tasks.some((x) => x.id === selection.id);
  const live = new Set(data.tasks.map((x) => x.id));
  setState({
    data,
    selection: exists ? selection : archived ? { kind: "archived", id: (selection as { id: string }).id } : null,
    picked: state.picked.filter((id) => live.has(id)),
  });
}

/**
 * Vite serves new UI code at once, but the server keeps the code it started with until a restart.
 * Fills in what an older server leaves out of the state, so the UI still renders against it.
 */
export function withDefaults(data: AppState): AppState {
  return {
    ...data,
    app: { ...data.app, restartable: data.app.restartable ?? false },
    folders: data.folders.map((f) => ({ ...f, settings: f.settings ?? {} })),
    tasks: data.tasks.map((t) => ({
      ...t,
      workspace: t.workspace ?? null,
      archivedAt: t.archivedAt ?? null,
      archivedBy: t.archivedBy ?? null,
      keep: t.keep ?? false,
      doneAt: t.doneAt ?? null,
    })),
    sessions: data.sessions.map((s) => ({
      ...s,
      busy: s.busy ?? false,
      agentSessionId: s.agentSessionId ?? null,
      lastOutputAt: s.lastOutputAt ?? null,
      lastInputAt: s.lastInputAt ?? null,
      asking: s.asking ?? false,
      waiting: s.waiting ?? false,
    })),
    signals: data.signals ?? [],
    settings: data.settings ?? { defs: [], values: {}, file: "" },
    processes: data.processes
      ? { ...data.processes, runs: data.processes.runs.map((r) => ({ ...r, progress: r.progress ?? null })) }
      : { defs: [], steps: [], runs: [] },
    restart: data.restart ?? null,
    archive: data.archive ?? { count: 0, dueSoon: 0, archiveAt: {} },
    automations: data.automations ?? [],
  };
}

/** Whether the server's code changed on disk since it started, so it needs a restart. */
export async function checkServerCode(): Promise<void> {
  const res = await fetch("/api/code").catch(() => null);
  if (!res) return;
  // A server older than this route is stale too.
  const stale = res.status === 404 || (res.ok && (await res.json().catch(() => null))?.stale === true);
  if (stale !== state.serverStale) setState({ serverStale: stale });
}

// Vite swaps changed UI modules in place; changed server modules load only after a restart.
import.meta.hot?.on("vite:afterUpdate", () => void checkServerCode());

// WebSocket

type EventHandler = (name: string, payload: any) => void;
type PtyHandler = (msg: { t: "pty" | "pty-reset"; data: string }) => void;

const eventHandlers = new Set<EventHandler>();
const ptyHandlers = new Map<string, Set<PtyHandler>>();
let socket: WebSocket | undefined;

export function onEvent(handler: EventHandler): () => void {
  eventHandlers.add(handler);
  return () => eventHandlers.delete(handler);
}

export function send(msg: object): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
}

/** Streams a session's output; the first message replays what it printed so far. */
export function attach(id: string, handler: PtyHandler): () => void {
  let set = ptyHandlers.get(id);
  if (!set) ptyHandlers.set(id, (set = new Set()));
  set.add(handler);
  send({ t: "attach", id });
  return () => {
    set.delete(handler);
    if (set.size === 0) {
      ptyHandlers.delete(id);
      send({ t: "detach", id });
    }
  };
}

let refreshTimer: ReturnType<typeof setTimeout> | undefined;

export function connect(): void {
  socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  socket.onopen = () => {
    setState({ connected: true });
    for (const id of ptyHandlers.keys()) send({ t: "attach", id });
    void refresh();
    void checkServerCode();
  };
  socket.onclose = () => {
    setState({ connected: false });
    setTimeout(connect, 1000);
  };
  socket.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.t === "pty" || msg.t === "pty-reset") {
      for (const handler of ptyHandlers.get(msg.id) ?? []) handler(msg);
    } else if (msg.t === "event") {
      for (const handler of eventHandlers) handler(msg.name, msg.payload);
      // The state is small: reload it after any change instead of patching it.
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => void refresh(), 30);
    }
  };
}

function load<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null") ?? fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}
