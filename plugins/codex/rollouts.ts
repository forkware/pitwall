// Codex records each conversation in $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl, the first
// line describing it. Codex cannot be given an id at start, so a session's is found among these afterwards.
import { closeSync, existsSync, openSync, readdirSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Rollout {
  id: string;
  cwd: string;
  /** When the conversation began, ms. */
  startedAt: number;
}

/** Codex's data directory: CODEX_HOME, or ~/.codex. */
export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME || join(homedir(), ".codex");
}

/** Codex begins a conversation when it starts, a few seconds after the app started it, and records it with the first message. */
const BEFORE_MS = 5000;
const AFTER_MS = 60_000;

/**
 * The conversation of an agent the app started at `startedAt` in `cwd`: the one begun there closest after,
 * leaving out those other sessions have. Undefined until it was told something, as Codex records it only then.
 */
export function findRollout(
  cwd: string,
  startedAt: number,
  taken: ReadonlySet<string>,
  home = codexHome(),
  now = Date.now(),
): string | undefined {
  const from = startedAt - BEFORE_MS;
  const found = rollouts(home, from, now).filter(
    (r) => r.cwd === cwd && r.startedAt >= from && r.startedAt <= startedAt + AFTER_MS && !taken.has(r.id),
  );
  return found.sort((x, y) => Math.abs(x.startedAt - startedAt) - Math.abs(y.startedAt - startedAt))[0]?.id;
}

/** Rollouts in the day directories from `from` to `to`, local time as Codex names them. */
export function rollouts(home: string, from: number, to: number): Rollout[] {
  const result: Rollout[] = [];
  const day = new Date(from);
  day.setHours(0, 0, 0, 0);
  for (; day.getTime() <= to; day.setDate(day.getDate() + 1)) {
    const dir = join(
      home,
      "sessions",
      String(day.getFullYear()),
      String(day.getMonth() + 1).padStart(2, "0"),
      String(day.getDate()).padStart(2, "0"),
    );
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.startsWith("rollout-") || !name.endsWith(".jsonl")) continue;
      const rollout = parseMeta(firstLine(join(dir, name)));
      if (rollout) result.push(rollout);
    }
  }
  return result;
}

/** The session_meta line: {"type":"session_meta","payload":{"id","cwd","timestamp",...}}. */
export function parseMeta(line: string): Rollout | undefined {
  try {
    const { type, payload } = JSON.parse(line);
    // Non-interactive runs (`codex exec`) are not agents in a terminal.
    if (type !== "session_meta" || !payload?.id || !payload.cwd || payload.source === "exec") return undefined;
    const startedAt = Date.parse(payload.timestamp);
    return Number.isNaN(startedAt) ? undefined : { id: payload.id, cwd: payload.cwd, startedAt };
  } catch {
    return undefined;
  }
}

/** The first line of a file that may be large; the session_meta line carries Codex's instructions. */
function firstLine(file: string, limit = 1024 * 1024): string {
  const fd = openSync(file, "r");
  try {
    const chunk = Buffer.alloc(64 * 1024);
    const parts: Buffer[] = [];
    for (let total = 0; total < limit; ) {
      const n = readSync(fd, chunk, 0, chunk.length, total);
      if (n === 0) break;
      const end = chunk.subarray(0, n).indexOf(10);
      if (end >= 0) {
        parts.push(Buffer.from(chunk.subarray(0, end)));
        break;
      }
      parts.push(Buffer.from(chunk.subarray(0, n)));
      total += n;
    }
    return Buffer.concat(parts).toString("utf8");
  } finally {
    closeSync(fd);
  }
}
