// Which directory a folder has, and what the new-folder dialog starts with and saves. No Node here: the UI uses it too.
import type { Folder } from "#sdk/types";

export const ID = "local-dir";

export const bound = (folder: Folder): string | undefined => (folder.meta[ID] as { path: string } | undefined)?.path;

/** The nearest folder up from `folderId` that has a directory. */
export function boundFrom(folders: Folder[], folderId: string | null): Folder | undefined {
  for (let f = folders.find((x) => x.id === folderId); f; f = folders.find((x) => x.id === f!.parentId)) {
    if (bound(f)) return f;
  }
  return undefined;
}

/** What the new-folder dialog's path starts with: the directory a subfolder would inherit, else the home directory. */
export function newFolderPath(folders: Folder[], parentId: string | null): string {
  const from = boundFrom(folders, parentId);
  return (from && bound(from)) ?? "~";
}

/**
 * The path the new folder is bound to, or null to leave it unbound: an empty field, or the directory
 * a subfolder inherits anyway (so it keeps following its parent).
 */
export function pathToBind(folders: Folder[], parentId: string | null, typed: string): string | null {
  const path = typed.trim();
  if (!path) return null;
  const from = boundFrom(folders, parentId);
  return from && bound(from) === path ? null : path;
}
