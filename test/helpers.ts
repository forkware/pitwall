import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { createCore, type AppOptions, type Core } from "../src/server/app.ts";

export const root = join(import.meta.dirname, "..");

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** A core with a fresh data directory and, by default, no plugins. */
export async function testCore(options: Partial<AppOptions> = {}): Promise<Core> {
  const dataDir = mkdtempSync(join(tmpdir(), "agent-test-"));
  const core = await createCore({ root, dataDir, pluginsDir: join(dataDir, "no-plugins"), ...options });
  cleanups.push(() => {
    core.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return core;
}

/** A provider that runs a shell command instead of a real agent. */
export const fakeProvider = (script: string) => ({
  id: "fake",
  label: "Fake agent",
  command: process.platform === "win32" ? "cmd.exe" : "sh",
  args: ({ prompt }: { prompt?: string }) =>
    process.platform === "win32" ? ["/c", script] : ["-c", script, "fake", prompt ?? ""],
});

export function waitFor(check: () => boolean, timeout = 5000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (check()) return resolve();
      if (Date.now() - start > timeout) return reject(new Error("Timed out"));
      setTimeout(tick, 20);
    };
    tick();
  });
}
