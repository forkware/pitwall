import { describe, expect, it } from "vitest";
import { LOG_TEXT_MAX, sessionLogText, stripAnsi } from "../src/server/sessions.ts";

// How an agent's interface such as Claude Code draws: it moves the cursor to the next row instead of printing "\n".
const row = (i: number) => `\r\x1b[5C\x1b[1B\x1b[2m· line ${i} of the answer\x1b[22m`;

describe("a session's log as text", () => {
  // #45: an archived task's page printed a long session as one line of megabytes, and the window hung.
  it("breaks lines where the cursor moves to another row", () => {
    const text = sessionLogText(Array.from({ length: 50 }, (_, i) => row(i)).join(""));
    const lines = text.split("\n").filter(Boolean);
    expect(lines).toHaveLength(50);
    expect(lines[3].trim()).toBe("· line 3 of the answer");
    expect(stripAnsi(row(1) + row(2)).split("\n")).toHaveLength(1); // what it was before
  });

  it("keeps only the end of a long log, in short lines", () => {
    const raw = Array.from({ length: 200_000 }, (_, i) => row(i)).join("");
    const text = sessionLogText(raw);
    expect(text.length).toBeLessThanOrEqual(LOG_TEXT_MAX);
    expect(text.endsWith("line 199999 of the answer")).toBe(true);
    expect(Math.max(...text.split("\n").map((l) => l.length))).toBeLessThan(100);
  });

  it("collapses blank rows and drops terminal modes", () => {
    expect(sessionLogText("a\x1b[H\x1b[2J\r\n\r\n\r\n\r\nb\x1b(B\x1b7\x1b8\x1b[<u\x1b[>4m")).toBe("a\n\nb");
  });
});
