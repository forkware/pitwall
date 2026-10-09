import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findRollout, parseMeta } from "../rollouts.ts";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

/** A CODEX_HOME with rollouts as Codex writes them: one per conversation, in the local day's directory. */
function home(rollouts: { id: string; cwd: string; at: number; source?: string }[]): string {
  const dir = mkdtempSync(join(tmpdir(), "codex-home-"));
  homes.push(dir);
  for (const r of rollouts) {
    const d = new Date(r.at);
    const day = join(dir, "sessions", String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"));
    mkdirSync(day, { recursive: true });
    const meta = {
      timestamp: new Date(r.at + 9000).toISOString(),
      type: "session_meta",
      payload: { id: r.id, cwd: r.cwd, timestamp: new Date(r.at).toISOString(), source: r.source ?? "vscode", base_instructions: { text: "x".repeat(100_000) } },
    };
    writeFileSync(join(day, `rollout-${r.at}-${r.id}.jsonl`), JSON.stringify(meta) + "\n" + '{"type":"event_msg"}\n');
  }
  return dir;
}

const start = new Date(2026, 9, 7, 12, 0, 0).getTime();

describe("codex rollouts", () => {
  it("finds the conversation begun in the session's directory right after its start", () => {
    const h = home([
      { id: "other-dir", cwd: "/elsewhere", at: start + 2000 },
      { id: "ours", cwd: "/work", at: start + 3000 },
      { id: "later", cwd: "/work", at: start + 40_000 },
    ]);
    expect(findRollout("/work", start, new Set(), h, start + 120_000)).toBe("ours");
    // Another session already has it: the next one in time is a different agent's.
    expect(findRollout("/work", start + 39_000, new Set(["ours"]), h, start + 120_000)).toBe("later");
  });

  it("has none before the first message, and ignores old conversations and codex exec runs", () => {
    const h = home([
      { id: "yesterday", cwd: "/work", at: start - 86_400_000 },
      { id: "exec", cwd: "/work", at: start + 1000, source: "exec" },
      { id: "much-later", cwd: "/work", at: start + 10 * 60_000 },
    ]);
    expect(findRollout("/work", start, new Set(), h, start + 20 * 60_000)).toBeUndefined();
  });

  it("reads a session_meta line and nothing else", () => {
    expect(parseMeta('{"type":"session_meta","payload":{"id":"a","cwd":"/w","timestamp":"2026-10-07T09:00:49.201Z"}}')).toEqual({
      id: "a",
      cwd: "/w",
      startedAt: Date.parse("2026-10-07T09:00:49.201Z"),
    });
    expect(parseMeta('{"type":"event_msg"}')).toBeUndefined();
    expect(parseMeta("not json")).toBeUndefined();
  });
});
