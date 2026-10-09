// Drops known harmless lines from the desktop window's output, such as Chromium's Wayland warnings.
import type { Readable, Writable } from "node:stream";

/** Lines containing any of these are noise. Users change the list through the logFilter setting. */
export const defaultLogFilter = ["The server has buggy presentation feedback"];

export function isNoise(line: string, patterns: unknown): boolean {
  if (!Array.isArray(patterns)) return false;
  return patterns.some((p) => typeof p === "string" && p !== "" && line.includes(p));
}

/** Copies `input` to `output` line by line, leaving out noise. `patterns` is read per line, so edits apply at once. */
export function pipeFiltered(input: Readable, output: Writable, patterns: () => unknown): void {
  let rest = "";
  input.setEncoding("utf8");
  input.on("data", (chunk: string) => {
    const lines = (rest + chunk).split("\n");
    rest = lines.pop() ?? "";
    const list = patterns();
    const kept = lines.filter((line) => !isNoise(line, list));
    if (kept.length) output.write(kept.join("\n") + "\n");
  });
  input.on("end", () => {
    if (rest && !isNoise(rest, patterns())) output.write(rest);
  });
}
