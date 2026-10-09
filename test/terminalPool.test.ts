import { describe, expect, it } from "vitest";
import { chunks, TerminalPool } from "../src/ui/terminalPool.ts";

function makePool(limit: number) {
  const created: string[] = [];
  const disposed: string[] = [];
  const pool = new TerminalPool<string>(
    (id) => (created.push(id), id),
    (id) => disposed.push(id),
    () => limit,
  );
  /** Opens a session's terminal and leaves it, as switching to its task and away does. */
  const visit = (id: string) => {
    pool.acquire(id);
    pool.release(id);
  };
  return { pool, created, disposed, visit };
}

describe("TerminalPool", () => {
  it("keeps a terminal after it leaves the screen and reuses it", () => {
    const { pool, created, visit } = makePool(5);
    visit("a");
    visit("b");
    expect(pool.acquire("a")).toBe("a");
    expect(created).toEqual(["a", "b"]);
  });

  it("disposes the least recently used terminal when the pool is full", () => {
    const { pool, disposed, visit } = makePool(3);
    visit("a");
    visit("b");
    visit("c");
    visit("a"); // a is now the most recent
    visit("d");
    expect(disposed).toEqual(["b"]);
    expect(pool.ids()).toEqual(["c", "a", "d"]);
  });

  it("never disposes a terminal on screen, even over the limit", () => {
    const { pool, disposed } = makePool(1);
    pool.acquire("a");
    pool.acquire("b"); // two sessions of one task are mounted together
    expect(disposed).toEqual([]);
    pool.release("a");
    expect(disposed).toEqual(["a"]);
    expect(pool.ids()).toEqual(["b"]);
  });

  it("creates a new terminal after an evicted one is needed again", () => {
    const { pool, created, visit } = makePool(1);
    visit("a");
    visit("b");
    pool.acquire("a");
    expect(created).toEqual(["a", "b", "a"]);
  });

  it("removes a terminal on request, e.g. when its session is deleted", () => {
    const { pool, disposed, visit } = makePool(5);
    visit("a");
    pool.remove("a");
    pool.remove("a");
    expect(disposed).toEqual(["a"]);
    expect(pool.has("a")).toBe(false);
  });

  it("treats a broken limit as one", () => {
    const { pool, visit } = makePool(Number.NaN);
    visit("a");
    visit("b");
    expect(pool.ids()).toEqual(["b"]);
  });
});

describe("chunks", () => {
  it("leaves short output whole", () => {
    expect(chunks("hello", 10)).toEqual(["hello"]);
  });

  it("splits long output into parts that join back", () => {
    const data = "x".repeat(25);
    const parts = chunks(data, 10);
    expect(parts.map((p) => p.length)).toEqual([10, 10, 5]);
    expect(parts.join("")).toBe(data);
  });

  it("does not split a surrogate pair", () => {
    const data = "a".repeat(9) + "😀" + "b".repeat(5);
    const parts = chunks(data, 10);
    expect(parts.join("")).toBe(data);
    for (const part of parts) expect(part).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
  });
});
