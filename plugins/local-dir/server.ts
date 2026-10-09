import { existsSync, statSync } from "node:fs";
import { definePlugin } from "#sdk/server";
import { browse, expand } from "./browse.ts";

export interface Binding {
  path: string;
}

export default definePlugin((ctx) => {
  // The nearest folder with a directory wins, so subfolders inherit it.
  ctx.workspaces.registerResolver((_task, folders) => {
    for (const folder of folders) {
      const binding = folder.meta[ctx.id] as Binding | undefined;
      if (binding?.path && existsSync(binding.path)) return binding.path;
    }
    return undefined;
  });

  const directory = (path: string) => {
    const dir = expand(path);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`Not a directory: ${dir}`);
    return dir;
  };

  ctx.rpc.handle("bind", ({ folderId, path }: { folderId: string; path: string }) => {
    if (!path?.trim()) return ctx.folders.update(folderId, { meta: { [ctx.id]: null } });
    return ctx.folders.update(folderId, { meta: { [ctx.id]: { path: directory(path) } satisfies Binding } });
  });

  // The new-folder dialog checks its path before it makes the folder.
  ctx.rpc.handle("check", ({ path }: { path: string }) => directory(path));

  // The picker in the UI: the server's disks, so it works in the browser too.
  ctx.rpc.handle("browse", ({ path }: { path?: string }) => browse(path ?? ""));
});
