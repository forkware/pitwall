// Entry point.
//   node src/cli.ts                      desktop window
//   node src/cli.ts --server [--port N]  web server, open the printed link in a browser
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createCore } from "./server/app.ts";
import { startHttp } from "./server/http.ts";
import { QUIET_MS } from "./server/restart.ts";
import { defaultLogFilter, pipeFiltered } from "./server/logFilter.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// `pnpm start -- --server` hands the script a literal "--"; the options come after it.
const argv = process.argv.slice(2);
const { values: args } = parseArgs({
  args: argv[0] === "--" ? argv.slice(1) : argv,
  options: {
    server: { type: "boolean", default: false },
    host: { type: "string", default: "127.0.0.1" },
    port: { type: "string" },
    token: { type: "string" },
    built: { type: "boolean", default: false },
    "data-dir": { type: "string" },
    provider: { type: "string" },
    set: { type: "string", multiple: true },
    settings: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (args.help) {
  console.log(`Usage: pnpm start [options]

  --server          Run as a web server instead of a desktop window
  --host <host>     Address to listen on (default 127.0.0.1)
  --port <port>     Port (default 4870 for --server, any free one for the window)
  --token <token>   Login token for --server (default: kept in the data directory)
  --built           Serve the UI built by \`pnpm run build\` instead of compiling it live
  --data-dir <dir>  Where folders, tasks and sessions are stored
  --provider <id>   Default agent, same as --set defaultProvider=<id>
  --set key=value   Set a setting for this run; repeat for several. Also PITWALL_<KEY>=value,
                    e.g. PITWALL_DEFAULT_PROVIDER=codex
  --settings <file> Settings file (default <data dir>/settings.json, or PITWALL_SETTINGS)`);
  process.exit(0);
}

useOldEnvNames();
const dataDir = args["data-dir"] ?? process.env.PITWALL_DATA_DIR ?? defaultDataDir();
if (dataDir === defaultDataDir()) moveOldDataDir();
/** The exit code with which the server asks to be started again. */
const RESTART = 75;

// The process `pnpm start` runs only supervises: it runs the server as a child process, starts it again
// when it asks for a restart, and keeps the desktop window open meanwhile.
if (process.env.PITWALL_SERVER_CHILD === "1") await serve();
else supervise();

function supervise() {
  // Fixed for all the server's runs, so the window's link and login stay valid across restarts.
  const token = args.token ?? process.env.PITWALL_TOKEN ?? (args.server ? savedToken(dataDir) : newToken());
  let port = args.port;
  let logFilter: unknown = defaultLogFilter;
  let server: ChildProcess;
  let window: ChildProcess | undefined;
  let announced = false;
  let stopping = false;
  /** The first Ctrl-C asked the server to stop once its agents are quiet. */
  let stopAsked = false;

  const startServer = () => {
    const argv = [...process.execArgv, fileURLToPath(import.meta.url), ...process.argv.slice(2)];
    server = spawn(process.execPath, port ? [...argv, "--port", port] : argv, {
      stdio: ["inherit", "inherit", "inherit", "ipc"],
      env: { ...process.env, PITWALL_SERVER_CHILD: "1", PITWALL_TOKEN: token },
    });
    server.on("message", (msg: { t: string; url?: string; port?: number; value?: unknown }) => {
      if (msg.t === "logFilter") logFilter = msg.value;
      if (msg.t !== "ready") return;
      port = String(msg.port);
      if (args.server && !announced) {
        console.log(`Pitwall is running. Open this link, it carries your login token:\n\n  ${msg.url}\n`);
        if (!["127.0.0.1", "localhost", "::1"].includes(args.host))
          console.log("Anyone with the link can run commands on this machine through the agents. Keep it private.\n");
      } else if (!args.server && !window) {
        window = openWindow(msg.url!, () => logFilter, quit);
      }
      announced = true;
    });
    server.on("exit", (code, signal) => {
      if (code === RESTART && !stopping && !stopAsked) {
        console.log("Restarting agent's server…");
        return startServer();
      }
      stopping = true;
      window?.kill();
      process.exit(code ?? (signal ? 1 : 0));
    });
  };
  const quitNow = () => {
    if (stopping) return;
    stopping = true;
    server.kill("SIGTERM");
  };
  // First Ctrl-C (or closing the window): stop once no agent is mid-answer. Second one: stop now.
  const quit = () => {
    if (stopping) return;
    if (stopAsked || !server.connected) return quitNow();
    stopAsked = true;
    server.send({ t: "stop" });
  };
  process.on("SIGINT", quit);
  process.on("SIGTERM", quitNow);
  startServer();
}

async function serve() {
  const supervised = typeof process.send === "function";
  const core = await createCore({
    root,
    dataDir,
    defaultProvider: args.provider,
    settings: {
      file: args.settings ?? process.env.PITWALL_SETTINGS ?? join(dataDir, "settings.json"),
      env: process.env,
      cli: parseSets(args.set ?? []),
    },
    restart: supervised ? () => void stop(RESTART) : undefined,
  });
  const httpOptions = {
    host: args.host,
    port: Number(args.port ?? (args.server ? 4870 : 4871)),
    token: args.token ?? process.env.PITWALL_TOKEN ?? (args.server ? savedToken(dataDir) : newToken()),
    built: args.built,
  };
  // The window prefers a fixed port, so the page keeps its saved layout between launches.
  const http = await startHttp(core, httpOptions).catch((error) => {
    if (args.server || args.port || error.code !== "EADDRINUSE") throw error;
    return startHttp(core, { ...httpOptions, port: 0 });
  });

  let stopping = false;
  async function stop(code = 0) {
    if (stopping) return;
    stopping = true;
    await http.close();
    core.close();
    process.exit(code);
  }
  let waiting: ReturnType<typeof setInterval> | undefined;
  /** Stops when no agent is busy, so none is cut off mid-answer; the sessions resume after the next start. */
  function stopWhenQuiet() {
    if (stopping) return;
    if (waiting) return void stop(); // asked twice
    core.restart.cancel();
    const busy = core.sessions.busy().length;
    if (busy === 0) return void stop();
    console.log(
      `Waiting for ${busy} agent${busy === 1 ? "" : "s"} to finish answering. Press Ctrl-C again to quit now.`,
    );
    let quietSince = 0;
    waiting = setInterval(() => {
      if (core.sessions.busy().length > 0) quietSince = 0;
      else if (!quietSince) quietSince = Date.now();
      else if (Date.now() - quietSince >= QUIET_MS) {
        clearInterval(waiting);
        void stop();
      }
    }, 250);
  }
  // Under the supervisor, Ctrl-C reaches this process too; the supervisor decides and sends "stop".
  process.on("SIGINT", () => (supervised ? undefined : stopWhenQuiet()));
  process.on("SIGTERM", () => void stop());
  process.on("message", (msg: { t?: string }) => msg?.t === "stop" && stopWhenQuiet());
  // The supervisor is gone, e.g. killed: nothing would show this server any more.
  process.on("disconnect", () => void stop());

  const sendLogFilter = () => process.send?.({ t: "logFilter", value: core.settings.get("logFilter") });
  sendLogFilter();
  core.events.on("settings.changed", (p: { key: string }) => p.key === "logFilter" && sendLogFilter());
  process.send?.({ t: "ready", url: http.url, port: http.port });
}

/** The desktop window is Electron showing the same page a browser would. */
function openWindow(url: string, logFilter: () => unknown, onExit: () => void): ChildProcess | undefined {
  let electron: string;
  try {
    electron = createRequire(import.meta.url)("electron") as string;
  } catch {
    console.log(`Electron is not installed. Open ${url} in a browser, or run pnpm install.`);
    return undefined;
  }
  const flags = process.platform === "linux" ? ["--no-sandbox"] : [];
  const child = spawn(electron, [...flags, join(root, "src", "desktop", "main.cjs")], {
    stdio: ["inherit", "inherit", "pipe"],
    // Its own process group, so Ctrl-C in the terminal reaches only the supervisor, which decides.
    detached: process.platform !== "win32",
    env: { ...process.env, PITWALL_URL: url, ELECTRON_RUN_AS_NODE: undefined },
  });
  pipeFiltered(child.stderr, process.stderr, logFilter);
  child.on("error", () => console.log(`Could not open a window. Open ${url} in a browser.`));
  child.on("exit", onExit);
  return child;
}

/** `--set key=value` pairs; the value may contain "=". */
function parseSets(pairs: string[]): Record<string, string> {
  const sets: Record<string, string> = {};
  for (const pair of pairs) {
    const at = pair.indexOf("=");
    if (at <= 0) {
      console.error(`--set needs key=value, got "${pair}"`);
      process.exit(1);
    }
    sets[pair.slice(0, at)] = pair.slice(at + 1);
  }
  return sets;
}

function defaultDataDir(name = "forkware-pitwall"): string {
  if (process.platform === "win32") return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), name);
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", name);
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), name);
}

/**
 * The app used to be called forkware-agent. Its data moves to the new directory, and the old path stays
 * as a link to it: sessions keep the directory they started in, and resuming them needs that path.
 */
function moveOldDataDir() {
  const old = defaultDataDir("forkware-agent");
  if (existsSync(dataDir) || !existsSync(old)) return;
  try {
    renameSync(old, dataDir);
    symlinkSync(dataDir, old, "junction");
  } catch (error) {
    console.error(`Could not move ${old} to ${dataDir}:`, error);
  }
}

/** Variables used to start with AGENT_; they still work where the PITWALL_ one is not set. */
function useOldEnvNames() {
  const old = Object.keys(process.env).filter((name) => name.startsWith("AGENT_"));
  for (const name of old) {
    const now = "PITWALL_" + name.slice("AGENT_".length);
    process.env[now] ??= process.env[name];
    delete process.env[name];
  }
  if (old.length) console.warn(`Rename ${old.join(", ")}: the prefix is PITWALL_ now.`);
}

function newToken(): string {
  return randomBytes(24).toString("base64url");
}

/** The server keeps its token, so the link stays valid across restarts. */
function savedToken(dir: string): string {
  const file = join(dir, "token");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  mkdirSync(dir, { recursive: true });
  const token = newToken();
  writeFileSync(file, token, { mode: 0o600 });
  return token;
}
