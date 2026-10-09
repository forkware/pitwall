// Reloading the page without a blank screen. A merge into the checkout the app runs from (Ready to deploy) makes
// Vite reload the page; until the new page has loaded its scripts and styles, the window would show an empty page.
// Instead the page navigates to itself, which, unlike a reload, may run a view transition (index.html opts in):
// the old picture stays until the new page has drawn, and the new page draws at once from the state it was left with.

const STASH = "agent.reload.state";

interface Storage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Keeps the state for the page that comes after the reload. */
export function stash(storage: Storage, value: unknown): void {
  try {
    storage.setItem(STASH, JSON.stringify(value));
  } catch {}
}

/** The state the page before the reload left, once. */
export function takeStash<T>(storage: Storage): T | null {
  try {
    const raw = storage.getItem(STASH);
    storage.removeItem(STASH);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

interface FullReload {
  path?: string;
}

/**
 * Takes Vite's full reloads over: `reload` runs once the changes settle (a merge writes many files).
 * Vite's client reloads unless the payload names another HTML page, so the payload is pointed at one.
 */
export function takeOverReloads(
  on: (event: "vite:beforeFullReload", listener: (payload: FullReload) => void) => void,
  reload: () => void,
  settle = 100,
): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  on("vite:beforeFullReload", (payload) => {
    payload.path = "/__reloaded-by-the-app__.html";
    clearTimeout(timer);
    timer = setTimeout(reload, settle);
  });
}

/** Navigates to the same page: a reload, but one a view transition can cover. */
export function navigateToSelf(location: Pick<Location, "href" | "replace">): void {
  // A link that differs only in its #fragment would just scroll.
  location.replace(location.href.split("#")[0]);
}
