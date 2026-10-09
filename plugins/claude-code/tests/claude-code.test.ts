import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { waitsForLimit } from "../server.ts";
import { hasTranscript } from "../transcripts.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function claudeDir(files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "claude-dir-"));
  dirs.push(dir);
  for (const file of files) {
    mkdirSync(join(dir, "projects", file, ".."), { recursive: true });
    writeFileSync(join(dir, "projects", file), "{}\n");
  }
  return dir;
}

describe("claude transcripts", () => {
  it("finds a session's transcript under its directory's project name", () => {
    const dir = claudeDir(["-home-me-my-app-v2/abc.jsonl"]);
    expect(hasTranscript("abc", "/home/me/my.app_v2", dir)).toBe(true);
    expect(hasTranscript("other", "/home/me/my.app_v2", dir)).toBe(false);
  });

  it("finds it under another project name, as Claude shortens long paths", () => {
    const dir = claudeDir(["-home-me-shortened-1234/abc.jsonl"]);
    expect(hasTranscript("abc", "/home/me/" + "deep/".repeat(60), dir)).toBe(true);
  });

  it("has none when nothing was said yet", () => {
    expect(hasTranscript("abc", "/w", claudeDir([]))).toBe(false);
  });
});

describe("claude usage limit", () => {
  const prompt = "\n╭──────────╮\n│ >        │\n╰──────────╯\n  ? for shortcuts\n";

  it("knows Claude waiting for its limit to reset", () => {
    expect(waitsForLimit("● Usage limit reached again · continuing automatically at 3:30pm · esc to cancel\n" + prompt)).toBe(true);
    expect(waitsForLimit("You've hit your session limit · resets 3:30pm (Europe/Moscow)\n" + prompt)).toBe(true);
  });

  it("does not take a quiet Claude, or one near its limit, for waiting", () => {
    expect(waitsForLimit("● Done: the tests pass.\n" + prompt)).toBe(false);
    expect(waitsForLimit("● Done.\n" + prompt + "Approaching usage limit · resets at 3pm\n")).toBe(false);
  });

  it("forgets the limit once it scrolled off the screen", () => {
    expect(waitsForLimit("Usage limit reached · continuing automatically at 3:30pm\n" + "● working\n".repeat(200) + prompt)).toBe(false);
  });
});
