import { definePlugin } from "#sdk/server";

/** What the badge shows: the repository, its page and its star count, or `null` when GitHub never answered. */
export interface Stars {
  repo: string;
  url: string;
  count: number | null;
}

interface Cached {
  repo: string;
  count: number;
  at: number;
}

export const hour = 60 * 60 * 1000;
/** After a failed request, the next try waits this long, so a machine offline does not ask on every page load. */
const retryAfter = 5 * 60 * 1000;

export default definePlugin((ctx) => {
  ctx.settings.define([
    {
      key: "repo",
      label: "Repository",
      description: "The GitHub repository (owner/name) whose stars the badge shows. The original, not your fork: that is what gets promoted.",
      type: "string",
      default: "forkware/pitwall",
    },
  ]);

  let failedAt = 0;
  let pending: Promise<number | null> | undefined;

  // Unauthenticated GitHub API allows 60 requests an hour per address: the count is kept for an hour in kv.
  const fetchCount = async (repo: string): Promise<number | null> => {
    try {
      const res = await fetch(`https://api.github.com/repos/${repo}`, {
        headers: { accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
      const body = (await res.json()) as { stargazers_count?: unknown };
      if (typeof body.stargazers_count !== "number") throw new Error("No stargazers_count");
      ctx.kv.set("cache", { repo, count: body.stargazers_count, at: Date.now() } satisfies Cached);
      return body.stargazers_count;
    } catch (error) {
      failedAt = Date.now();
      ctx.log("stars unavailable:", error instanceof Error ? error.message : String(error));
      return null;
    }
  };

  ctx.rpc.handle("stars", async (): Promise<Stars> => {
    const repo = (ctx.settings.get<string>("repo") || "forkware/pitwall").trim();
    const url = `https://github.com/${repo}`;
    const cached = ctx.kv.get<Cached>("cache");
    const known = cached?.repo === repo ? cached : undefined;
    const fresh = known && Date.now() - known.at < hour;
    if (fresh || Date.now() - failedAt < retryAfter) return { repo, url, count: known?.count ?? null };
    pending ??= fetchCount(repo).finally(() => (pending = undefined));
    // A stale count is better than none when GitHub is out of reach.
    return { repo, url, count: (await pending) ?? known?.count ?? null };
  });
});
