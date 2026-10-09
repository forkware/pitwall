// Git for the development process: the worktree a task works in, and merging it into the integration branch.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, globSync, mkdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Runs git and says whether it succeeded, with what it printed. */
export function tryGit(cwd: string, ...args: string[]): { ok: boolean; out: string } {
  try {
    return { ok: true, out: git(cwd, ...args) };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; message: string };
    return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}`.trim() || e.message };
  }
}

/** The repository's top directory, when `dir` is in one with at least one commit. */
export function repoRoot(dir: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  const top = tryGit(dir, "rev-parse", "--show-toplevel");
  if (!top.ok || !tryGit(dir, "rev-parse", "--verify", "HEAD").ok) return undefined;
  return top.out;
}

export const branchExists = (repo: string, branch: string) =>
  tryGit(repo, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`).ok;

/** A name fit for a branch and a directory: lower case words joined by hyphens. */
export function toSlug(text: string, max = 50): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return slug || "task";
}

/** Where a repository's worktrees go unless a setting says otherwise: next to it, `<repo>-worktrees`. */
export const defaultWorktrees = (repo: string) => join(dirname(repo), `${basename(repo)}-worktrees`);

/** `slug`, or `slug-2`, `slug-3`... : the first that is neither a branch nor a directory yet. */
export function freeSlug(repo: string, worktrees: string, slug: string): string {
  for (let n = 1; ; n++) {
    const name = n === 1 ? slug : `${slug}-${n}`;
    if (!branchExists(repo, name) && !existsSync(join(worktrees, name))) return name;
  }
}

/** A new worktree on a new branch `slug` from `base`. */
export function addWorktree(repo: string, dir: string, slug: string, base: string): void {
  mkdirSync(dirname(dir), { recursive: true });
  git(repo, "worktree", "add", "-b", slug, dir, base);
}

/** A worktree at `dir` again: on `branch` as it is, or, with `from`, on a new branch `branch` made from `from`. */
export function restoreWorktree(repo: string, dir: string, branch: string, from?: string): void {
  mkdirSync(dirname(dir), { recursive: true });
  tryGit(repo, "worktree", "prune");
  if (from) git(repo, "worktree", "add", "-b", branch, dir, from);
  else git(repo, "worktree", "add", dir, branch);
}

/** Whether `commit` is in `ref`'s history: a branch merged into it, say. */
export const isAncestor = (repo: string, commit: string, ref: string) =>
  tryGit(repo, "merge-base", "--is-ancestor", commit, ref).ok;

export function deleteBranch(repo: string, branch: string): boolean {
  return tryGit(repo, "branch", "-D", branch).ok;
}

/**
 * Copies into the worktree the files git leaves out (ignored ones such as .env) that match the patterns,
 * relative to the repository. Files the worktree already has stay as they are. Returns what it copied.
 */
export function copyIgnored(repo: string, worktree: string, patterns: string[]): string[] {
  const copied: string[] = [];
  for (const pattern of patterns) {
    for (const file of globSync(pattern, { cwd: repo })) {
      const from = join(repo, file);
      const to = join(worktree, file);
      if (!statSync(from).isFile() || existsSync(to)) continue;
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
      copied.push(file);
    }
  }
  return copied;
}

/** Commits whatever the agent left uncommitted in the worktree. Returns whether there was anything. */
export function commitAll(worktree: string, message: string): boolean {
  git(worktree, "add", "-A");
  if (tryGit(worktree, "diff", "--cached", "--quiet").ok) return false;
  git(worktree, "commit", "-m", message);
  return true;
}

/** The directory where `branch` is checked out, if it is. */
export function checkoutOf(repo: string, branch: string): string | undefined {
  let dir: string | undefined;
  for (const line of git(repo, "worktree", "list", "--porcelain").split("\n")) {
    if (line.startsWith("worktree ")) dir = line.slice("worktree ".length);
    else if (line === `branch refs/heads/${branch}`) return dir;
  }
  return undefined;
}

/** Local changes to tracked files; untracked ones do not get in a merge's way. */
export const isDirty = (dir: string) => git(dir, "status", "--porcelain", "--untracked-files=no") !== "";

export type MergeResult = { ok: true; base: string; commit: string } | { ok: false; conflict: string };

/** Merges `branch` into what `dir` has checked out, with a merge commit. A conflict is undone. */
export function merge(dir: string, branch: string, message: string): MergeResult {
  const base = git(dir, "rev-parse", "HEAD");
  const result = tryGit(dir, "merge", "--no-ff", "-m", message, branch);
  if (result.ok) return { ok: true, base, commit: git(dir, "rev-parse", "HEAD") };
  const files = tryGit(dir, "diff", "--name-only", "--diff-filter=U").out;
  tryGit(dir, "merge", "--abort");
  return { ok: false, conflict: files ? `Conflicting files:\n${files}` : result.out };
}

/** Takes the merge back, when nothing came after it; local changes stay (`reset --keep`). */
export function undoMerge(dir: string, base: string, commit: string): boolean {
  if (git(dir, "rev-parse", "HEAD") !== commit) return false;
  return tryGit(dir, "reset", "--keep", base).ok;
}

export function removeWorktree(repo: string, dir: string): void {
  tryGit(repo, "worktree", "remove", "--force", dir);
}

/** `dir`'s place inside the repository, so the same place can be found in a worktree. */
export const inRepo = (repo: string, dir: string) => relative(repo, dir);
