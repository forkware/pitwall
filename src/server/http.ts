// One HTTP server for both modes: the desktop window and a browser load the same UI from it.
// The UI talks to the core only through /api and /ws, never through Electron.
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { UserError } from "./store.ts";
import type { Core } from "./app.ts";
import { previewCron } from "./automations.ts";

export interface HttpOptions {
  host: string;
  port: number;
  token: string;
  /** Serve the prebuilt UI from dist/ui instead of compiling it live with Vite. */
  built?: boolean;
}

type Params = Record<string, string>;
type Route = [method: string, pattern: RegExp, handler: (p: Params, body: any, query: URLSearchParams) => unknown];


export async function startHttp(core: Core, options: HttpOptions) {
  const { store, sessions, plugins, settings, processes, archive, automations, state, codeChanged } = core;
  /** Archived tasks are read only: they are restored first. */
  const editable = (id: string) => {
    const task = store.task(id);
    if (task?.archivedAt) throw new UserError("The task is in the archive: restore it first");
    return task;
  };
  const ids = (b: any): string[] => {
    if (!Array.isArray(b.ids) || b.ids.some((x: unknown) => typeof x !== "string")) throw new UserError("ids: a list of task ids");
    return b.ids;
  };
  // Per port, so a desktop window and a server on the same host keep separate logins.
  let cookieName = "agent_token";

  const routes: Route[] = [
    ["GET", /^\/api\/state$/, () => state()],
    ["GET", /^\/api\/audit$/, () => plugins.audit()],
    ["GET", /^\/api\/code$/, () => ({ stale: codeChanged() })],
    [
      "POST",
      /^\/api\/restart$/,
      () => {
        if (!core.app.restartable) throw new UserError("This app cannot restart itself: start it with pnpm start");
        core.restart.request();
      },
    ],
    ["DELETE", /^\/api\/restart$/, () => core.restart.cancel()],
    [
      "POST",
      /^\/api\/folders$/,
      (_, b) => {
        // A new folder's settings come with it, from the dialog that names it; checked before it is made.
        const own = Object.entries((b.settings ?? {}) as Record<string, unknown>);
        for (const [key, value] of own) settings.checkFolder(key, value);
        const folder = store.createFolder({ name: b.name, parentId: b.parentId });
        for (const [key, value] of own) settings.setFolder(folder.id, key, value);
        return store.folder(folder.id);
      },
    ],
    ["PATCH", /^\/api\/folders\/(?<id>[^/]+)$/, (p, b) => store.updateFolder(p.id, { name: b.name, parentId: b.parentId })],
    ["DELETE", /^\/api\/folders\/(?<id>[^/]+)$/, (p) => store.deleteFolder(p.id)],
    ["PUT", /^\/api\/settings\/(?<key>[^/]+)$/, (p, b) => settings.set(p.key, b.value)],
    [
      "PUT",
      /^\/api\/folders\/(?<id>[^/]+)\/settings\/(?<key>[^/]+)$/,
      (p, b) => settings.setFolder(p.id, p.key, b.value),
    ],
    [
      "POST",
      /^\/api\/tasks$/,
      (_, b) => {
        const input = { folderId: b.folderId, title: b.title, body: b.body };
        return b.process ? processes.createTask(input, b.process, b.input) : store.createTask(input);
      },
    ],
    [
      "GET",
      /^\/api\/tasks\/(?<id>[^/]+)$/,
      (p) => {
        const task = store.task(p.id);
        return task ? archive.describe(task) : null;
      },
    ],
    ["POST", /^\/api\/tasks\/archive$/, (_, b) => ids(b).map((id) => store.archiveTask(id, "user"))],
    ["POST", /^\/api\/tasks\/restore$/, (_, b) => ids(b).map((id) => store.restoreTask(id))],
    ["POST", /^\/api\/tasks\/delete$/, (_, b) => void ids(b).forEach((id) => store.deleteTask(id))],
    [
      "PATCH",
      /^\/api\/tasks\/(?<id>[^/]+)$/,
      (p, b) => {
        if (typeof b.keep === "boolean") store.setKeep(p.id, b.keep);
        const changes = ["status", "title", "body", "folderId"].some((k) => b[k] !== undefined);
        if (changes) editable(p.id);
        // A task that follows a process moves by answering it.
        if (b.status !== undefined) {
          if (processes.owns(p.id)) processes.setStatus(p.id, b.status);
          else store.setStatus(p.id, b.status);
        }
        const { title, body, folderId } = b;
        return title !== undefined || body !== undefined || folderId !== undefined
          ? store.updateTask(p.id, { title, body, folderId })
          : store.task(p.id);
      },
    ],
    ["DELETE", /^\/api\/tasks\/(?<id>[^/]+)$/, (p) => store.deleteTask(p.id)],
    ["GET", /^\/api\/archive$/, (_, __, q) => archive.list(q.get("folderId"))],
    ["GET", /^\/api\/archive\/deletions$/, (_, __, q) => store.deletions(Number(q.get("since") ?? 0))],
    [
      "POST",
      /^\/api\/archive\/preview$/,
      (_, b) => archive.preview(b.key, b.value, b.folderId ?? null).map((t) => ({ id: t.id, title: t.title })),
    ],
    ["POST", /^\/api\/archive\/sweep$/, () => archive.sweep()],
    ["POST", /^\/api\/archive\/hold$/, (_, b) => archive.hold(b.key, b.value, b.folderId ?? null, Number(b.days ?? 7))],
    ["GET", /^\/api\/sessions\/(?<id>[^/]+)\/log$/, (p) => ({ text: sessions.log(p.id) })],
    ["POST", /^\/api\/automations$/, (_, b) => automations.create(b)],
    ["POST", /^\/api\/automations\/cron$/, (_, b) => previewCron(String(b.cron ?? ""), String(b.timezone ?? ""))],
    ["PATCH", /^\/api\/automations\/(?<id>[^/]+)$/, (p, b) => automations.update(p.id, b)],
    ["DELETE", /^\/api\/automations\/(?<id>[^/]+)$/, (p, _, q) => automations.remove(p.id, q.get("tasks") === "archive" ? "archive" : "keep")],
    ["GET", /^\/api\/automations\/(?<id>[^/]+)\/runs$/, (p) => automations.runs(p.id)],
    ["POST", /^\/api\/automations\/(?<id>[^/]+)\/run$/, (p, b) => automations.fire(p.id, "manual", b.payload)],
    ["POST", /^\/api\/automations\/(?<id>[^/]+)\/secret$/, (p) => automations.newSecret(p.id)],
    ["POST", /^\/api\/tasks\/(?<id>[^/]+)\/sessions$/, (p, b) => sessions.start(p.id, { provider: b.provider })],
    ["POST", /^\/api\/tasks\/(?<id>[^/]+)\/process$/, (p, b) => processes.start(p.id, b.process, b.input)],
    ["POST", /^\/api\/tasks\/(?<id>[^/]+)\/process\/resume$/, (p, b) => processes.resume(p.id, b.answer)],
    ["POST", /^\/api\/tasks\/(?<id>[^/]+)\/process\/retry$/, (p) => processes.retry(p.id)],
    ["GET", /^\/api\/tasks\/(?<id>[^/]+)\/process\/trace$/, (p) => processes.trace(p.id)],
    ["GET", /^\/api\/processes\/(?<id>[^/]+)\/versions$/, (p) => processes.versions(p.id)],
    ["POST", /^\/api\/sessions\/(?<id>[^/]+)\/kill$/, (p) => sessions.kill(p.id)],
    ["POST", /^\/api\/sessions\/(?<id>[^/]+)\/suspend$/, (p) => sessions.suspend(p.id)],
    ["DELETE", /^\/api\/sessions\/(?<id>[^/]+)$/, (p) => sessions.remove(p.id)],
    [
      "POST",
      /^\/api\/plugins\/(?<plugin>[^/]+)\/rpc\/(?<name>[^/]+)$/,
      (p, b) => {
        const handler = plugins.loaded.get(p.plugin)?.rpc.get(p.name);
        if (!handler) throw new UserError(`No procedure ${p.plugin}.${p.name}`);
        return handler(b);
      },
    ],
  ];

  const isAuthorized = (req: IncomingMessage) => {
    const header = req.headers.authorization?.replace(/^Bearer /, "");
    const cookie = parseCookies(req.headers.cookie)[cookieName];
    return [header, cookie].some((t) => t !== undefined && safeEqual(t, options.token));
  };

  let vite: Awaited<ReturnType<typeof createVite>> | undefined;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    // The link with ?token= logs the browser in once, then the cookie does.
    const token = url.searchParams.get("token");
    if (token !== null) {
      if (!safeEqual(token, options.token)) return send(res, 401, unauthorizedPage, "text/html");
      url.searchParams.delete("token");
      res.setHeader("Set-Cookie", `${cookieName}=${options.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`);
      res.setHeader("Location", url.pathname + url.search);
      return send(res, 302, "");
    }
    // An agent's `pitwall` command: its own token, good for its session only.
    if (url.pathname === "/api/agent/signal" && req.method === "POST") return handleSignal(req, res);
    // An automation's webhook proves itself with its own secret.
    const hook = /^\/hooks\/(?<id>[^/]+)(?:\/(?<secret>[^/]+))?\/?$/.exec(url.pathname);
    if (hook) return handleHook(req, res, hook.groups!.id, hook.groups!.secret);
    if (!isAuthorized(req)) return send(res, 401, unauthorizedPage, "text/html");

    if (url.pathname.startsWith("/api/")) return handleApi(req, res, url.pathname, url.searchParams);
    if (vite) return vite.middlewares(req, res);
    return serveStatic(res, url.pathname);
  });

  vite = options.built ? undefined : await createVite();

  async function handleHook(req: IncomingMessage, res: ServerResponse, id: string, secret?: string) {
    if (req.method !== "POST") return send(res, 405, JSON.stringify({ error: "Send a POST" }), "application/json");
    try {
      const raw = await readRaw(req);
      const answer = await automations.hook(decodeURIComponent(id), secret && decodeURIComponent(secret), req.headers, raw);
      send(res, answer.status, JSON.stringify(answer.body), "application/json");
    } catch (error) {
      console.error(error);
      send(res, 500, JSON.stringify({ error: (error as Error).message }), "application/json");
    }
  }

  async function handleApi(req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams) {
    for (const [method, pattern, handler] of routes) {
      const match = req.method === method && pattern.exec(path);
      if (!match) continue;
      try {
        const body = method === "GET" ? {} : await readJson(req);
        const params = Object.fromEntries(Object.entries(match.groups ?? {}).map(([k, v]) => [k, decodeURIComponent(v)]));
        const result = await handler(params, body, query);
        return send(res, 200, JSON.stringify(result ?? null), "application/json");
      } catch (error) {
        const user = error instanceof UserError;
        if (!user) console.error(error);
        return send(res, user ? 400 : 500, JSON.stringify({ error: (error as Error).message }), "application/json");
      }
    }
    send(res, 404, JSON.stringify({ error: "Not found" }), "application/json");
  }

  async function handleSignal(req: IncomingMessage, res: ServerResponse) {
    const token = req.headers.authorization?.replace(/^Agent /, "") ?? "";
    try {
      const body = await readJson(req);
      const reply = token ? await sessions.signalByToken(token, String(body.name ?? ""), String(body.text ?? "")) : undefined;
      if (reply === undefined) return send(res, 401, "This agent is not running in Pitwall, or the app restarted it\n");
      send(res, 200, reply + "\n");
    } catch (error) {
      const user = error instanceof UserError;
      if (!user) console.error(error);
      send(res, user ? 400 : 500, (error as Error).message + "\n");
    }
  }

  // WebSocket: events to every client, terminal streams to the clients attached to a session.
  const wss = new WebSocketServer({ noServer: true });
  const attached = new Map<WebSocket, Set<string>>();
  server.on("upgrade", (req, socket, head) => {
    if (new URL(req.url ?? "/", "http://localhost").pathname !== "/ws") return; // Vite's HMR socket
    if (!isAuthorized(req)) {
      socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
  });
  wss.on("connection", (ws: WebSocket) => {
    attached.set(ws, new Set());
    ws.on("close", () => attached.delete(ws));
    ws.on("message", (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.t === "attach") {
        attached.get(ws)?.add(msg.id);
        ws.send(JSON.stringify({ t: "pty-reset", id: msg.id, data: sessions.scrollback(msg.id) }));
        // Opening a session the app's restart suspended brings its agent back.
        sessions.resume(msg.id);
      } else if (msg.t === "detach") attached.get(ws)?.delete(msg.id);
      else if (msg.t === "input") sessions.write(msg.id, String(msg.data));
      else if (msg.t === "resize") sessions.resize(msg.id, Number(msg.cols), Number(msg.rows));
    });
  });
  core.events.onAny((name, payload) => {
    if (name === "session.output") {
      const { id, data } = payload as { id: string; data: string };
      const frame = JSON.stringify({ t: "pty", id, data });
      for (const [ws, ids] of attached) if (ids.has(id)) ws.send(frame);
      return;
    }
    const frame = JSON.stringify({ t: "event", name, payload });
    for (const ws of attached.keys()) ws.send(frame);
  });

  async function createVite() {
    const { createServer: createViteServer } = await import("vite");
    return createViteServer({
      configFile: join(core.app.root, "vite.config.ts"),
      server: { middlewareMode: true, ws: { server }, allowedHosts: true },
      appType: "spa",
    });
  }

  function serveStatic(res: ServerResponse, pathname: string) {
    const dist = join(core.app.root, "dist", "ui");
    let file = normalize(join(dist, decodeURIComponent(pathname)));
    if (!file.startsWith(dist) || !existsSync(file) || statSync(file).isDirectory()) file = join(dist, "index.html");
    if (!existsSync(file)) return send(res, 500, "The UI is not built: run `pnpm run build` or start without --built");
    res.writeHead(200, { "Content-Type": mime[extname(file)] ?? "application/octet-stream" });
    createReadStream(file).pipe(res);
  }

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port, options.host, resolve);
    });
  } catch (error) {
    await vite?.close();
    throw error;
  }
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  cookieName = `agent_token_${port}`;
  const loopback = options.host === "0.0.0.0" || options.host === "::" ? "127.0.0.1" : options.host;
  sessions.agentUrl = `http://${loopback.includes(":") ? `[${loopback}]` : loopback}:${port}`;

  return {
    port,
    url: `http://${options.host.includes(":") ? `[${options.host}]` : options.host}:${port}/?token=${options.token}`,
    async close() {
      for (const ws of attached.keys()) ws.terminate();
      await vite?.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

const unauthorizedPage = `<!doctype html><meta charset="utf-8"><title>Pitwall</title>
<body style="font:15px system-ui;background:#0b0c0f;color:#e7e9ee;display:grid;place-items:center;height:100vh;margin:0">
<p>Open the link with <code>?token=</code> that <b>Pitwall</b> printed in the terminal.</p>`;

const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json",
};

function send(res: ServerResponse, status: number, body: string, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type });
  res.end(body);
}

/** At most 5 MB: a webhook's body. */
async function readRaw(req: IncomingMessage): Promise<string> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 5 * 1024 * 1024) throw new UserError("The request body is too large");
  }
  return raw;
}

async function readJson(req: IncomingMessage): Promise<any> {
  const raw = await readRaw(req);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new UserError("Request body is not JSON");
  }
}

function parseCookies(header?: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of header?.split(";") ?? []) {
    const [key, ...value] = part.trim().split("=");
    if (key) cookies[key] = value.join("=");
  }
  return cookies;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
