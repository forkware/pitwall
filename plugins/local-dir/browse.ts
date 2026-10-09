// What the directory picker shows: a directory's subdirectories, the path to it and the disks to jump to.
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import nodePath from "node:path";

export type PlatformPath = typeof nodePath.posix;

export interface Place {
  name: string;
  path: string;
}

export interface Listing {
  path: string;
  parent: string | null;
  /** From the root down to `path`, for the clickable path above the list. */
  crumbs: Place[];
  dirs: { name: string; path: string; hidden: boolean }[];
  /** "/" on Linux and macOS; the drives on Windows. */
  roots: Place[];
  home: string;
  /** Set when the directory exists but cannot be read; `dirs` is then empty. */
  error?: string;
}

export interface Env {
  path: PlatformPath;
  home: string;
  /** Whether a directory exists; a drive that does not answer counts as missing. */
  probe: (dir: string) => Promise<boolean>;
}

const isDir = (dir: string) =>
  stat(dir).then(
    (s) => s.isDirectory(),
    () => false,
  );

/** A disconnected network drive can hang for a long time; the picker does not wait for it. */
const probeDrive = (dir: string) =>
  Promise.race([isDir(dir), new Promise<boolean>((done) => setTimeout(done, 1500, false).unref())]);

const hostEnv = (): Env => ({ path: nodePath, home: homedir(), probe: probeDrive });

/** A path as the user typed or pasted it: `~`, quotes from "Copy as path", a bare `D:` for the drive. */
export function expand(input: string, env: Pick<Env, "path" | "home"> = hostEnv()): string {
  let raw = input.trim().replace(/^"(.*)"$/, "$1").trim();
  if (!raw) return env.home;
  raw = raw.replace(/^~(?=$|[/\\])/, env.home);
  if (env.path.sep === "\\" && /^[a-z]:$/i.test(raw)) raw += "\\";
  return env.path.resolve(raw);
}

export function crumbs(dir: string, path: PlatformPath): Place[] {
  const { root } = path.parse(dir);
  const name = root === path.sep ? root : root.replace(/[/\\]+$/, "");
  const list: Place[] = [{ name, path: root }];
  let at = root;
  for (const part of dir.slice(root.length).split(/[/\\]+/).filter(Boolean)) {
    at = path.join(at, part);
    list.push({ name: part, path: at });
  }
  return list;
}

export async function roots(current: string, env: Env): Promise<Place[]> {
  if (env.path.sep === "/") return [{ name: "/", path: "/" }];
  const letters = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"];
  const found = await Promise.all(letters.map((l) => env.probe(`${l}:\\`)));
  const list = letters.filter((_, i) => found[i]).map((l) => ({ name: `${l}:`, path: `${l}:\\` }));
  // The drive or network share we are on, even if it did not answer in time.
  const own = crumbs(current, env.path)[0]!;
  if (!list.some((r) => r.path.toLowerCase() === own.path.toLowerCase())) list.push(own);
  return list;
}

const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" }).compare;

/** Lists the subdirectories of a directory. Throws when the path is not a directory. */
export async function browse(input: string, env: Env = hostEnv()): Promise<Listing> {
  const dir = expand(input, env);
  if (!(await isDir(dir))) throw new Error(`Not a directory: ${dir}`);
  const parent = env.path.dirname(dir);
  const listing: Listing = {
    path: dir,
    parent: parent === dir ? null : parent,
    crumbs: crumbs(dir, env.path),
    dirs: [],
    roots: await roots(dir, env),
    home: env.home,
  };
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const names = await Promise.all(
      entries.map(async (e) =>
        e.isDirectory() || (e.isSymbolicLink() && (await isDir(env.path.join(dir, e.name)))) ? e.name : null,
      ),
    );
    listing.dirs = names
      .filter((n): n is string => n !== null)
      .sort(byName)
      // $Recycle.Bin and the like on Windows drives.
      .map((name) => ({ name, path: env.path.join(dir, name), hidden: name.startsWith(".") || name.startsWith("$") }));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    listing.error = code === "EACCES" || code === "EPERM" ? `No access to ${dir}` : (error as Error).message;
  }
  return listing;
}
