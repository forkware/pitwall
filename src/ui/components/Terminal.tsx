import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal as XTerm } from "@xterm/xterm";
import { LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { attach, getState, onEvent, send } from "../api.ts";
import { t } from "../i18n.ts";
import { settingValue } from "../sdk.tsx";
import { guardMiddleClickPaste } from "../middleClickPaste.ts";
import { attachTerminalPlugins } from "../slots.tsx";
import { chunks, TerminalPool } from "../terminalPool.ts";
import { treeKeepsFocus } from "../treeKeys.ts";

/** An xterm bound to one session's output. Lives in the pool, outside React, between visits to its task. */
interface Entry {
  element: HTMLDivElement;
  /** Opens the terminal once its element is in the document, where xterm can measure it. */
  open(): void;
  /** Fits the terminal to its element; `force` tells the agent the size even if it did not change. */
  fit(force?: boolean): void;
  focus(): void;
  /** True while the output so far is being replayed into the terminal. */
  loading: boolean;
  listeners: Set<() => void>;
  dispose(): void;
}

function createEntry(sessionId: string): Entry {
  const element = document.createElement("div");
  element.className = "absolute inset-0";
  let term: XTerm | undefined;
  let size = "";
  let cleanup = () => {};
  // Each replay gets a number, so a replay cut short by a newer one does not end the loading state.
  let replay = 0;

  const entry: Entry = {
    element,
    loading: true,
    listeners: new Set(),
    open() {
      if (term) return;
      const css = getComputedStyle(document.documentElement);
      const v = (name: string) => css.getPropertyValue(name).trim();
      const xterm = (term = new XTerm({
        fontFamily: '"JetBrains Mono Variable", ui-monospace, monospace',
        fontSize: 13,
        lineHeight: 1.25,
        cursorBlink: true,
        allowProposedApi: true,
        scrollback: 10000,
        theme: {
          background: v("--bg"),
          foreground: v("--text"),
          cursor: v("--accent"),
          cursorAccent: v("--bg"),
          selectionBackground: `${v("--accent")}55`,
        },
      }));
      const fitAddon = new FitAddon();
      xterm.loadAddon(fitAddon);
      xterm.loadAddon(new WebLinksAddon((_, uri) => window.open(uri, "_blank")));
      xterm.open(element);

      entry.fit = (force = false) => {
        // A pooled terminal off screen has no size; fitting it would shrink the agent's terminal to nothing.
        if (!element.isConnected || element.clientWidth === 0 || element.clientHeight === 0) return;
        fitAddon.fit();
        const next = `${xterm.cols}x${xterm.rows}`;
        if (force || next !== size) send({ t: "resize", id: sessionId, cols: xterm.cols, rows: xterm.rows });
        size = next;
      };
      entry.focus = () => xterm.focus();

      const detach = attach(sessionId, (msg) => {
        if (msg.t !== "pty-reset") return xterm.write(msg.data);
        const current = ++replay;
        setLoading(true);
        xterm.reset();
        const parts = chunks(msg.data);
        parts.forEach((part, i) =>
          xterm.write(part, i === parts.length - 1 ? () => current === replay && setLoading(false) : undefined),
        );
      });
      const input = xterm.onData((data) => send({ t: "input", id: sessionId, data }));
      const tracksMouse = () => xterm.modes.mouseTrackingMode !== "none";
      const unguard = guardMiddleClickPaste(element, tracksMouse);
      const detachPlugins = attachTerminalPlugins({
        sessionId,
        element,
        paste: (text) => xterm.paste(text),
        selection: () => xterm.getSelection(),
        focus: () => xterm.focus(),
        tracksMouse,
      });
      const observer = new ResizeObserver(() => entry.fit());
      observer.observe(element);
      cleanup = () => {
        observer.disconnect();
        detachPlugins();
        unguard();
        input.dispose();
        detach();
        xterm.dispose();
      };
    },
    fit() {},
    focus() {},
    dispose() {
      cleanup();
      element.remove();
    },
  };

  function setLoading(loading: boolean) {
    entry.loading = loading;
    for (const listener of entry.listeners) listener();
  }

  return entry;
}

const defaultPoolSize = 5;
const pool = new TerminalPool<Entry>(
  createEntry,
  (entry) => entry.dispose(),
  () => settingValue<number>(getState(), "terminalPool") ?? defaultPoolSize,
);
onEvent((name, payload) => name === "session.removed" && pool.remove(payload.id));

/** The terminal of one agent session. Taken from the pool, so switching tasks or tabs is instant. */
export function Terminal({ sessionId, visible }: { sessionId: string; visible: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const [entry, setEntry] = useState<Entry | null>(null);

  useEffect(() => {
    const taken = pool.acquire(sessionId);
    host.current!.appendChild(taken.element);
    taken.open();
    taken.fit();
    setEntry(taken);
    return () => {
      taken.element.remove();
      pool.release(sessionId);
    };
  }, [sessionId]);

  useEffect(() => {
    if (!visible || !entry) return;
    const frame = requestAnimationFrame(() => {
      entry.fit(true);
      // Opened from the tree: the row keeps the focus, so Del and the arrows act on it.
      if (!treeKeepsFocus()) entry.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [visible, entry]);

  return (
    <div ref={host} className="absolute inset-0" style={{ visibility: visible ? "visible" : "hidden" }}>
      {entry && <Loading entry={entry} />}
    </div>
  );
}

/** Shows that output is being replayed; only after a moment, so a short replay does not flash. */
function Loading({ entry }: { entry: Entry }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      clearTimeout(timer);
      if (entry.loading) timer = setTimeout(() => setShown(true), 150);
      else setShown(false);
    };
    update();
    entry.listeners.add(update);
    return () => {
      clearTimeout(timer);
      entry.listeners.delete(update);
    };
  }, [entry]);

  if (!shown) return null;
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center gap-2 bg-bg/80 text-sm text-muted">
      <LoaderCircle size={16} className="animate-spin" aria-hidden />
      {t("loadingOutput")}
    </div>
  );
}
