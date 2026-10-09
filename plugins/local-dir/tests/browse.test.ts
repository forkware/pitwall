import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { browse, crumbs, expand, roots, type Env } from "../browse.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tree(entries: string[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), "local-dir-"));
  dirs.push(dir);
  for (const entry of entries) {
    if (entry.endsWith("/")) mkdirSync(path.join(dir, entry), { recursive: true });
    else writeFileSync(path.join(dir, entry), "");
  }
  return dir;
}

const posix: Env = { path: path.posix, home: "/home/me", probe: async () => true };
const windows = (drives: string[]): Env => ({
  path: path.win32,
  home: "C:\\Users\\me",
  probe: async (dir) => drives.includes(dir),
});

describe("local-dir picker: browse", () => {
  it("lists only subdirectories, by name with numbers in order, hidden ones marked", async () => {
    const dir = tree(["b/", "a10/", "a2/", ".git/", "file.txt"]);
    symlinkSync(path.join(dir, "b"), path.join(dir, "link"));
    const listing = await browse(dir, { ...posix, path: path });
    expect(listing.path).toBe(dir);
    expect(listing.dirs.map((d) => d.name)).toEqual([".git", "a2", "a10", "b", "link"]);
    expect(listing.dirs.find((d) => d.name === ".git")?.hidden).toBe(true);
    expect(listing.dirs.find((d) => d.name === "a2")?.path).toBe(path.join(dir, "a2"));
    expect(listing.parent).toBe(path.dirname(dir));
  });

  it("refuses a file or a missing path", async () => {
    const dir = tree(["file.txt"]);
    await expect(browse(path.join(dir, "file.txt"))).rejects.toThrow(/Not a directory/);
    await expect(browse(path.join(dir, "nope"))).rejects.toThrow(/Not a directory/);
  });

  it("the root has no parent", async () => {
    expect((await browse("/", { ...posix, path: path })).parent).toBeNull();
  });
});

describe("local-dir picker: paths", () => {
  it("expands ~, quotes and an empty path to home", () => {
    expect(expand("~/src", posix)).toBe("/home/me/src");
    expect(expand("  ", posix)).toBe("/home/me");
    expect(expand('"/opt/my app"', posix)).toBe("/opt/my app");
  });

  it("takes a bare drive letter on Windows as its root", () => {
    expect(expand("d:", windows([]))).toBe("d:\\");
    expect(expand('"D:\\Work\\app"', windows([]))).toBe("D:\\Work\\app");
    expect(expand("~\\src", windows([]))).toBe("C:\\Users\\me\\src");
  });

  it("splits a path into clickable parts", () => {
    expect(crumbs("/home/me", path.posix)).toEqual([
      { name: "/", path: "/" },
      { name: "home", path: "/home" },
      { name: "me", path: "/home/me" },
    ]);
    expect(crumbs("D:\\Work\\app", path.win32)).toEqual([
      { name: "D:", path: "D:\\" },
      { name: "Work", path: "D:\\Work" },
      { name: "app", path: "D:\\Work\\app" },
    ]);
    expect(crumbs("\\\\nas\\share\\docs", path.win32)).toEqual([
      { name: "\\\\nas\\share", path: "\\\\nas\\share\\" },
      { name: "docs", path: "\\\\nas\\share\\docs" },
    ]);
  });
});

describe("local-dir picker: disks", () => {
  it("is just / on Linux and macOS", async () => {
    expect(await roots("/home/me", posix)).toEqual([{ name: "/", path: "/" }]);
  });

  it("lists the drives that answer on Windows", async () => {
    expect(await roots("C:\\Users", windows(["C:\\", "E:\\"]))).toEqual([
      { name: "C:", path: "C:\\" },
      { name: "E:", path: "E:\\" },
    ]);
  });

  it("keeps the drive or share we are on even if it did not answer", async () => {
    const list = await roots("\\\\nas\\share\\docs", windows(["C:\\"]));
    expect(list.map((r) => r.name)).toEqual(["C:", "\\\\nas\\share"]);
  });
});
