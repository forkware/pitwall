import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { root, testCore } from "../../../test/helpers.ts";
import plugin, { hour, type Stars } from "../server.ts";
import { shortCount } from "../ui.tsx";

async function setup() {
  const core = await testCore();
  const manifest = JSON.parse(readFileSync(join(root, "plugins/github-stars/plugin.json"), "utf8"));
  const loaded = await core.plugins.load("github-stars", manifest, plugin);
  const stars = () => loaded.rpc.get("stars")!({}) as Promise<Stars>;
  return { core, stars };
}

function github(count: number) {
  return vi.fn(async () => new Response(JSON.stringify({ stargazers_count: count }), { status: 200 }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("github-stars", () => {
  it("shows the original repository's stars and links to it", async () => {
    const fetch = github(42);
    vi.stubGlobal("fetch", fetch);
    const { stars } = await setup();
    expect(await stars()).toEqual({ repo: "forkware/pitwall", url: "https://github.com/forkware/pitwall", count: 42 });
    expect(fetch).toHaveBeenCalledWith("https://api.github.com/repos/forkware/pitwall", expect.anything());
  });

  it("asks GitHub at most once an hour", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const fetch = github(7);
    vi.stubGlobal("fetch", fetch);
    const { stars } = await setup();
    await Promise.all([stars(), stars()]);
    await stars();
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + hour + 1);
    await stars();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("without the network gives no count instead of failing, and keeps a count it had", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("fetch failed"))));
    const { stars } = await setup();
    expect((await stars()).count).toBeNull();

    vi.stubGlobal("fetch", github(5));
    vi.setSystemTime(Date.now() + 10 * 60 * 1000);
    expect((await stars()).count).toBe(5);

    vi.stubGlobal("fetch", vi.fn(async () => new Response("rate limited", { status: 403 })));
    vi.setSystemTime(Date.now() + 2 * hour);
    expect((await stars()).count).toBe(5);
  });

  it("follows the repository setting", async () => {
    const fetch = github(1);
    vi.stubGlobal("fetch", fetch);
    const { core, stars } = await setup();
    core.settings.set("github-stars.repo", "someone/else");
    expect((await stars()).url).toBe("https://github.com/someone/else");
    expect(fetch).toHaveBeenCalledWith("https://api.github.com/repos/someone/else", expect.anything());
  });

  it("shortens big counts like GitHub", () => {
    expect([999, 1000, 1234, 12_345].map(shortCount)).toEqual(["999", "1k", "1.2k", "12k"]);
  });
});
