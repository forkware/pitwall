import { mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { loadWindowState, saveWindowState, fitToDisplays, DEFAULTS } = require("../src/desktop/windowState.cjs");

const file = () => join(mkdtempSync(join(tmpdir(), "window-state-")), "window-state.json");
const screen = { x: 0, y: 0, width: 1920, height: 1080 };

describe("window state", () => {
  it("restores what was saved before the restart", () => {
    const path = file();
    saveWindowState(path, { x: 100, y: 50, width: 1200, height: 800, maximized: true, fullScreen: false });
    expect(loadWindowState(path)).toEqual({ x: 100, y: 50, width: 1200, height: 800, maximized: true, fullScreen: false });
  });

  it("opens with the defaults when nothing was saved or the file is broken", () => {
    expect(loadWindowState(file())).toEqual({ ...DEFAULTS, maximized: false, fullScreen: false });
    const path = file();
    writeFileSync(path, "{not json");
    expect(loadWindowState(path)).toEqual({ ...DEFAULTS, maximized: false, fullScreen: false });
  });

  it("keeps the position on a display that is still there", () => {
    const state = { x: 100, y: 50, width: 1200, height: 800, maximized: false, fullScreen: false };
    expect(fitToDisplays(state, [screen])).toEqual(state);
  });

  it("drops the position when its display is gone and caps the size", () => {
    const fitted = fitToDisplays({ x: 2500, y: 100, width: 2500, height: 1400, maximized: false, fullScreen: false }, [screen]);
    expect(fitted.x).toBeUndefined();
    expect(fitted.y).toBeUndefined();
    expect(fitted).toMatchObject({ width: 1920, height: 1080 });
  });
});
