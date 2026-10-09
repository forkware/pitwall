import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { serverCodeHash } from "../src/server/code.ts";
import type { AppState } from "../src/sdk/types.ts";
import { withDefaults } from "../src/ui/api.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function app(files: Record<string, string>): { root: string; write: (path: string, text: string) => void } {
  const root = mkdtempSync(join(tmpdir(), "agent-code-"));
  roots.push(root);
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  for (const [path, text] of Object.entries(files)) write(path, text);
  return { root, write };
}

describe("server code hash", () => {
  const files = {
    "src/server/app.ts": "export const a = 1;",
    "src/ui/App.tsx": "export const b = 1;",
    "src/ui/api.ts": "export const c = 1;",
    "plugins/p/server.ts": "export default 1;",
    "plugins/p/ui.tsx": "export default 1;",
    "plugins/p/tests/p.test.ts": "",
  };

  it("changes when the server or a plugin's server part changes", () => {
    for (const path of ["src/server/app.ts", "src/server/new.ts", "plugins/p/server.ts", "plugins/p/plugin.json"]) {
      const { root, write } = app(files);
      const before = serverCodeHash(root);
      write(path, "changed");
      expect(serverCodeHash(root), path).not.toBe(before);
    }
  });

  it("ignores the UI, which Vite reloads by itself, and tests", () => {
    for (const path of ["src/ui/App.tsx", "src/ui/api.ts", "plugins/p/ui.tsx", "plugins/p/tests/p.test.ts"]) {
      const { root, write } = app(files);
      const before = serverCodeHash(root);
      write(path, "changed");
      expect(serverCodeHash(root), path).toBe(before);
    }
  });
});

describe("state from an older server", () => {
  it("gets the fields the server did not send yet", () => {
    const old = {
      app: { name: "pitwall", version: "0.1.0", root: "/app" },
      folders: [{ id: "f1", name: "first", parentId: null }],
      tasks: [],
      sessions: [{ id: "s1", state: "running" }],
    } as unknown as AppState;
    const data = withDefaults(old);
    expect(data.settings).toEqual({ defs: [], values: {}, file: "" });
    expect(data.folders[0].settings).toEqual({});
    expect(data.processes).toEqual({ defs: [], steps: [], runs: [] });
    expect(data.sessions[0]).toMatchObject({ busy: false, agentSessionId: null });
    expect(data.app.restartable).toBe(false);
    expect(data.restart).toBeNull();
  });
});
