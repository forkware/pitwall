import { describe, expect, it } from "vitest";
import type { Folder } from "#sdk/types";
import { newFolderPath, pathToBind } from "../binding.ts";

const folder = (id: string, parentId: string | null, path?: string): Folder => ({
  id,
  parentId,
  name: id,
  position: 0,
  meta: path ? { "local-dir": { path } } : {},
  settings: {},
  createdAt: 0,
});

const folders = [folder("top", null, "/srv/app"), folder("sub", "top"), folder("free", null)];

describe("local-dir: the new-folder dialog's path", () => {
  it("starts at the home directory for a top folder or one under an unbound folder", () => {
    expect(newFolderPath(folders, null)).toBe("~");
    expect(newFolderPath(folders, "free")).toBe("~");
  });

  it("starts at the inherited directory for a subfolder", () => {
    expect(newFolderPath(folders, "top")).toBe("/srv/app");
    expect(newFolderPath(folders, "sub")).toBe("/srv/app");
  });

  it("binds a top folder to what is typed, ~ included", () => {
    expect(pathToBind(folders, null, "~")).toBe("~");
    expect(pathToBind(folders, null, " /opt/x ")).toBe("/opt/x");
  });

  it("leaves the folder unbound for an empty path or the directory it inherits anyway", () => {
    expect(pathToBind(folders, null, "  ")).toBeNull();
    expect(pathToBind(folders, "sub", "/srv/app")).toBeNull();
    expect(pathToBind(folders, "sub", "~")).toBe("~");
  });
});
