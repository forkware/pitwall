// The server loads its modules once, while Vite reloads the UI's as soon as they change.
// A fingerprint of the server-side code tells the UI when the running server is behind the disk.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** Hash of the code the server runs: the .ts and .json files in src/ except the UI, and in plugins except tests. */
export function serverCodeHash(root: string, pluginsDir = join(root, "plugins")): string {
  const hash = createHash("sha256");
  const files = [
    ...walk(join(root, "src"), (path) => !path.startsWith("src/ui/")),
    ...walk(pluginsDir, (path) => !/\/tests\//.test(path)),
  ];
  for (const file of files.sort()) {
    hash.update(slashes(relative(root, file)));
    hash.update(readFileSync(file));
  }
  return hash.digest("hex");

  function walk(dir: string, keep: (path: string) => boolean): string[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir).flatMap((name) => {
      if (name === "node_modules") return [];
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return walk(path, keep);
      return /\.(ts|json)$/.test(name) && keep(slashes(relative(root, path))) ? [path] : [];
    });
  }
}

const slashes = (path: string) => path.split(sep).join("/");
