import { describe, expect, it, vi } from "vitest";
import { navigateToSelf, stash, takeOverReloads, takeStash } from "../src/ui/reload.ts";

function memory() {
  const items = new Map<string, string>();
  return {
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => void items.set(k, v),
    removeItem: (k: string) => void items.delete(k),
  };
}

describe("reloading without a blank screen", () => {
  it("hands the state to the next page once", () => {
    const storage = memory();
    stash(storage, { tasks: [1] });
    expect(takeStash(storage)).toEqual({ tasks: [1] });
    expect(takeStash(storage)).toBeNull();
  });

  it("stops Vite's own reload and reloads once the changes settle", () => {
    vi.useFakeTimers();
    let listener: ((payload: { path?: string }) => void) | undefined;
    const reload = vi.fn();
    takeOverReloads((_, l) => (listener = l), reload, 100);
    const payloads = [{ path: "*" }, {}, { path: "/src/ui/api.ts" }];
    for (const payload of payloads) {
      listener!(payload);
      vi.advanceTimersByTime(50);
    }
    // Vite's client reloads only when the path is not some other HTML page.
    for (const payload of payloads) expect(payload.path).toMatch(/\.html$/);
    expect(reload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(reload).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("navigates to the page itself, without its #fragment", () => {
    const replace = vi.fn();
    navigateToSelf({ href: "http://127.0.0.1:4870/?token=x#a", replace });
    expect(replace).toHaveBeenCalledWith("http://127.0.0.1:4870/?token=x");
  });
});
