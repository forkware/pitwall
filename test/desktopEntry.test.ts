import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { installDesktopEntry, desktopEntry } = require("../src/desktop/desktopEntry.cjs");

const dir = () => mkdtempSync(join(tmpdir(), "desktop-entry-"));
/** A checkout with a run.sh, as the launcher needs. */
const checkout = () => {
  const root = dir();
  writeFileSync(join(root, "run.sh"), "");
  return root;
};

describe("desktop entry", () => {
  it("names the app and its icon, matching the window's id", () => {
    const text = desktopEntry("/home/u/forkware/pitwall", "/home/u/icon.png");
    expect(text).toContain("Name=Pitwall\n");
    expect(text).toContain("Icon=/home/u/icon.png\n");
    expect(text).toContain('Exec="/home/u/forkware/pitwall/run.sh"\n');
    expect(text).toContain("StartupWMClass=pitwall\n");
  });

  it("is written once and rewritten when it changes", () => {
    const apps = join(dir(), "applications");
    const root = checkout();
    expect(installDesktopEntry(root, "/icon.png", apps)).toBe(true);
    expect(installDesktopEntry(root, "/icon.png", apps)).toBe(false);
    expect(installDesktopEntry(root, "/new.png", apps)).toBe(true);
    expect(readFileSync(join(apps, "pitwall.desktop"), "utf8")).toContain("Icon=/new.png");
  });

  it("keeps another checkout's entry while that checkout exists", () => {
    const apps = dir();
    const main = checkout();
    installDesktopEntry(main, "/main.png", apps);
    expect(installDesktopEntry(checkout(), "/worktree.png", apps)).toBe(false);
    expect(readFileSync(join(apps, "pitwall.desktop"), "utf8")).toContain(join(main, "run.sh"));
  });

  it("takes over an entry whose checkout is gone", () => {
    const apps = dir();
    mkdirSync(apps, { recursive: true });
    writeFileSync(join(apps, "pitwall.desktop"), desktopEntry("/gone", "/gone.png"));
    const root = checkout();
    expect(installDesktopEntry(root, "/icon.png", apps)).toBe(true);
    expect(readFileSync(join(apps, "pitwall.desktop"), "utf8")).toContain(join(root, "run.sh"));
  });
});
