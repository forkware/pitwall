// Commands the process runs: the tests, and the dev stand that keeps running while the user tries the work.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

/** Keeps this much of a command's output. */
const KEEP = 200_000;

/** Runs a shell command to its end. */
export function runCommand(command: string, cwd: string, env: Record<string, string> = {}): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, env: { ...process.env, CI: "1", ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const add = (chunk: Buffer) => void (output = (output + chunk.toString()).slice(-KEEP));
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    child.on("error", (error) => resolve({ code: 127, output: output + error.message }));
    child.on("close", (code) => resolve({ code: code ?? 1, output }));
  });
}

/**
 * What installs the dependencies of a JavaScript project in `dir` that has none yet, by its lockfile: a fresh
 * worktree has no node_modules, so its tests and its stand would not run. Nothing for anything else.
 */
export function installCommand(dir: string): string | undefined {
  if (!existsSync(join(dir, "package.json")) || existsSync(join(dir, "node_modules"))) return undefined;
  if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm install --frozen-lockfile --prefer-offline";
  if (existsSync(join(dir, "yarn.lock"))) return "yarn install --frozen-lockfile";
  if (existsSync(join(dir, "package-lock.json"))) return "npm ci --prefer-offline";
  return undefined;
}

/** The last lines of a text, for a message an agent or a person reads. */
export function tail(text: string, lines = 60): string {
  return text.trimEnd().split("\n").slice(-lines).join("\n");
}

/** A port nothing listens on now. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

export const portIsFree = (port: number) =>
  new Promise<boolean>((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });

interface Stand {
  child: ChildProcess;
  port: number;
  output: string;
  exited: boolean;
}

/** Dev stands by task: one long-running command each, with its own PORT. */
export class Stands {
  private stands = new Map<string, Stand>();

  get(taskId: string): Stand | undefined {
    return this.stands.get(taskId);
  }

  /** Starts the task's stand, unless it runs already. Resolves after a moment, so a stand that fails at once shows it. */
  async start(taskId: string, command: string, cwd: string, port?: number): Promise<Stand> {
    const running = this.stands.get(taskId);
    if (running && !running.exited) return running;
    const usable = port && (await portIsFree(port)) ? port : await freePort();
    const child = spawn(command, {
      cwd,
      shell: true,
      // Its own process group, so stopping it stops what it started.
      detached: process.platform !== "win32",
      env: { ...process.env, PORT: String(usable) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stand: Stand = { child, port: usable, output: "", exited: false };
    const add = (chunk: Buffer) => void (stand.output = (stand.output + chunk.toString()).slice(-KEEP));
    child.stdout?.on("data", add);
    child.stderr?.on("data", add);
    child.on("exit", () => void (stand.exited = true));
    child.on("error", (error) => {
      stand.output += error.message;
      stand.exited = true;
    });
    this.stands.set(taskId, stand);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return stand;
  }

  stop(taskId: string): void {
    const stand = this.stands.get(taskId);
    this.stands.delete(taskId);
    if (!stand || stand.exited || !stand.child.pid) return;
    try {
      if (process.platform === "win32") spawn("taskkill", ["/pid", String(stand.child.pid), "/T", "/F"]);
      else process.kill(-stand.child.pid, "SIGTERM");
    } catch {}
  }

  stopAll(): void {
    for (const id of [...this.stands.keys()]) this.stop(id);
  }
}

/**
 * The address the stand prints for its port, with what it adds (a login token), else plain localhost.
 * Colors and the punctuation around it are left out.
 */
export function standLink(output: string, port: number): string {
  const plain = output.replace(/\x1b\[[0-9;]*m/g, "");
  const printed = plain.match(new RegExp(`https?://[\\w.\\[\\]:-]+:${port}(?![0-9])[^\\s"'<>)]*`, "g"))?.at(-1);
  return printed?.replace(/[.,;]+$/, "") ?? `http://localhost:${port}`;
}
