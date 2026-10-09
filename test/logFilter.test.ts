import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { defaultLogFilter, isNoise, pipeFiltered } from "../src/server/logFilter.ts";

const wayland =
  "[647087:1007/014820.289578:ERROR:ui/ozone/platform/wayland/host/wayland_frame_manager.cc:692] The server has buggy presentation feedback. Discarding all presentation feedback requests in all frames except the last 3.";

describe("log filter", () => {
  it("hides the Wayland presentation warning by default", () => {
    expect(isNoise(wayland, defaultLogFilter)).toBe(true);
    expect(isNoise("[1:ERROR:gpu] something real", defaultLogFilter)).toBe(false);
  });

  it("ignores a setting that is not a list of strings", () => {
    expect(isNoise(wayland, "buggy")).toBe(false);
    expect(isNoise(wayland, [""])).toBe(false);
  });

  it("keeps other lines, across chunk boundaries, and reads the list each time", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let list = defaultLogFilter;
    let text = "";
    output.on("data", (c) => (text += c));
    pipeFiltered(input, output, () => list);
    input.write(`${wayland}\nfirst line\nsec`);
    input.write("ond line\n");
    list = ["second"];
    input.write(`${wayland}\nsecond again\n`);
    input.end("tail");
    await new Promise((r) => input.on("end", r));
    expect(text).toBe(`first line\nsecond line\n${wayland}\ntail`);
  });
});
