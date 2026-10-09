// A dialog to pick a directory by clicking through the server's disks, or by typing a path.
import { ArrowUp, ChevronRight, Eye, EyeOff, Folder, HardDrive, House, LoaderCircle } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { addStrings, Button, cx, Dialog, IconButton, Input, rpc, showCustomDialog, t } from "#sdk/ui";
import type { Listing } from "./browse.ts";

addStrings({
  en: {
    "local-dir.picker.home": "Home",
    "local-dir.picker.up": "Up",
    "local-dir.picker.empty": "No folders here",
    "local-dir.picker.hidden": "Hidden",
    "local-dir.picker.choose": "Choose this folder",
    "local-dir.picker.path": "Path",
  },
  ru: {
    "local-dir.picker.home": "Домой",
    "local-dir.picker.up": "Вверх",
    "local-dir.picker.empty": "Здесь нет папок",
    "local-dir.picker.hidden": "Скрытые",
    "local-dir.picker.choose": "Выбрать эту папку",
    "local-dir.picker.path": "Путь",
  },
});

export interface PickOptions {
  title: string;
  description?: string;
  /** Where to start; the home directory when empty or missing. */
  initial?: string;
  /** A button that submits an empty path, e.g. "Unbind". */
  clear?: string;
  /** Throw to keep the dialog open with the message. */
  onSubmit: (path: string) => void | Promise<void>;
}

/** Opens the picker; it closes when onSubmit succeeds. */
export function pickDirectory(options: PickOptions): void {
  showCustomDialog((props) => <DirectoryPicker {...options} {...props} />);
}

// Remembered while the app is open.
let showHidden = false;

const samePath = (a: string, b: string) => a.replace(/[/\\]+$/, "").toLowerCase() === b.replace(/[/\\]+$/, "").toLowerCase();

export function DirectoryPicker(props: PickOptions & { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [hidden, setHidden] = useState(showHidden);
  const request = useRef(0);
  const list = useRef<HTMLDivElement>(null);
  const crumbBar = useRef<HTMLDivElement>(null);
  // Set when navigating from the list, so the keyboard stays there.
  const keepFocus = useRef(false);

  const go = async (path: string, fallback?: string) => {
    const id = ++request.current;
    setLoading(true);
    try {
      const next = await rpc<Listing>("local-dir", "browse", { path });
      if (id !== request.current) return;
      setListing(next);
      setTyped(next.path);
      setError(null);
    } catch (e) {
      if (id !== request.current) return;
      if (fallback !== undefined) return void go(fallback);
      setError((e as Error).message);
    } finally {
      if (id === request.current) setLoading(false);
    }
  };

  useEffect(() => {
    void go(props.initial ?? "", props.initial ? "" : undefined);
  }, []);

  useLayoutEffect(() => {
    crumbBar.current?.scrollTo({ left: crumbBar.current.scrollWidth });
    if (keepFocus.current) {
      keepFocus.current = false;
      (list.current?.querySelector<HTMLElement>("[data-dir]") ?? list.current)?.focus();
    }
  }, [listing]);

  const submit = async (path: string) => {
    try {
      await props.onSubmit(path);
      props.onOpenChange(false);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const dirs = listing?.dirs.filter((d) => hidden || !d.hidden) ?? [];
  const enter = (path: string) => {
    keepFocus.current = true;
    void go(path);
  };

  // Arrows move, Backspace goes up, letters jump to the first folder that starts with them.
  const typeahead = useRef({ text: "", at: 0 });
  const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(list.current?.querySelectorAll<HTMLElement>("[data-dir]") ?? [])];
    const index = items.indexOf(document.activeElement as HTMLElement);
    const focus = (i: number) => items[Math.max(0, Math.min(items.length - 1, i))]?.focus();
    if (e.key === "ArrowDown") focus(index + 1);
    else if (e.key === "ArrowUp") focus(index - 1);
    else if (e.key === "Home") focus(0);
    else if (e.key === "End") focus(items.length - 1);
    else if (e.key === "Backspace" && listing?.parent) enter(listing.parent);
    else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const now = Date.now();
      const text = (now - typeahead.current.at < 800 ? typeahead.current.text : "") + e.key.toLowerCase();
      typeahead.current = { text, at: now };
      focus(items.findIndex((el) => el.dataset.dir!.toLowerCase().startsWith(text)));
      if (!items.some((el) => el.dataset.dir!.toLowerCase().startsWith(text))) return;
    } else return;
    e.preventDefault();
  };

  const drive = listing?.crumbs[0]?.path;

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange} title={props.title} description={props.description} wide>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          // Enter in the path field opens what was typed; a second Enter chooses it.
          if (listing && !samePath(typed.trim(), listing.path)) void go(typed);
          else void submit(typed);
        }}
      >
        <div className="flex flex-wrap items-center gap-1">
          <Button type="button" size="sm" variant="ghost" icon={House} onClick={() => listing && enter(listing.home)}>
            {t("local-dir.picker.home")}
          </Button>
          {listing && listing.roots.length > 1 && (
            <>
              <span className="mx-1 h-4 w-px bg-line" />
              {listing.roots.map((root) => (
                <Button
                  key={root.path}
                  type="button"
                  size="sm"
                  variant={drive && samePath(drive, root.path) ? "secondary" : "ghost"}
                  icon={HardDrive}
                  aria-pressed={!!drive && samePath(drive, root.path)}
                  onClick={() => enter(root.path)}
                >
                  {root.name}
                </Button>
              ))}
            </>
          )}
        </div>

        <div className="mt-2 flex items-center gap-1 rounded-t-md border border-b-0 border-line bg-raised px-1.5 py-1">
          <IconButton
            type="button"
            icon={ArrowUp}
            label={t("local-dir.picker.up")}
            disabled={!listing?.parent}
            className="disabled:opacity-40"
            onClick={() => listing?.parent && enter(listing.parent)}
          />
          <div ref={crumbBar} className="flex min-w-0 flex-1 items-center overflow-x-auto whitespace-nowrap [scrollbar-width:none]">
            {listing?.crumbs.map((c, i) => (
              <span key={c.path} className="flex items-center">
                {i > 0 && <ChevronRight size={12} className="shrink-0 text-faint" />}
                <button
                  type="button"
                  onClick={() => enter(c.path)}
                  className={cx(
                    "rounded px-1.5 py-0.5 text-[12px] hover:bg-hover",
                    i === listing.crumbs.length - 1 ? "font-medium text-text" : "text-muted",
                  )}
                >
                  {c.name}
                </button>
              </span>
            ))}
          </div>
          {loading && <LoaderCircle size={14} className="mr-1 shrink-0 animate-spin text-faint" />}
        </div>

        <div
          ref={list}
          tabIndex={-1}
          onKeyDown={onListKey}
          className={cx(
            "h-72 overflow-y-auto rounded-b-md border border-line bg-bg p-1 outline-none transition-opacity",
            loading && "opacity-60",
          )}
        >
          {listing?.error ? (
            <div className="grid h-full place-items-center px-6 text-center text-xs text-muted">{listing.error}</div>
          ) : listing && dirs.length === 0 ? (
            <div className="grid h-full place-items-center text-xs text-faint">{t("local-dir.picker.empty")}</div>
          ) : (
            dirs.map((d) => (
              <button
                key={d.name}
                type="button"
                data-dir={d.name}
                onClick={() => enter(d.path)}
                className={cx(
                  "flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] outline-none hover:bg-hover focus-visible:bg-hover focus-visible:ring-1 focus-visible:ring-accent",
                  d.hidden && "text-muted",
                )}
              >
                <Folder size={14} className="shrink-0 text-faint" />
                <span className="truncate">{d.name}</span>
              </button>
            ))
          )}
        </div>

        <Input
          aria-label={t("local-dir.picker.path")}
          className="mt-3 font-mono text-[12px]"
          value={typed}
          spellCheck={false}
          onChange={(e) => {
            setTyped(e.target.value);
            setError(null);
          }}
        />
        {error && <div className="mt-1.5 text-xs text-danger">{error}</div>}

        <div className="mt-4 flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            icon={hidden ? Eye : EyeOff}
            aria-pressed={hidden}
            onClick={() => setHidden((showHidden = !hidden))}
          >
            {t("local-dir.picker.hidden")}
          </Button>
          <div className="flex-1" />
          {props.clear && (
            <Button type="button" variant="ghost" onClick={() => void submit("")}>
              {props.clear}
            </Button>
          )}
          <Button type="button" variant="ghost" onClick={() => props.onOpenChange(false)}>
            {t("cancel")}
          </Button>
          <Button type="button" variant="primary" disabled={!typed.trim()} onClick={() => void submit(typed)}>
            {t("local-dir.picker.choose")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
