// A process's draft: what the user changed and not applied yet. It is kept on the server as it changes, so it
// outlives the page; the installed process stays as it was until "Apply".
import { useCallback, useEffect, useRef, useState } from "react";
import { attempt, rpc, type ProcessInfo, type ProcessSpec } from "#sdk/ui";
import { diffSpecs, sameSpec, type SpecDiff } from "./specs.ts";
import type { Draft } from "./server.ts";

export interface DraftState {
  /** The spec shown: the draft's, else the process's own. */
  spec: ProcessSpec;
  /** The draft as the core sees it (its nodes, issues), or the process when there is no draft. */
  info: ProcessInfo;
  dirty: boolean;
  diff: SpecDiff;
  loaded: boolean;
  change: (next: ProcessSpec | ((spec: ProcessSpec) => ProcessSpec)) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  /** Drops the draft: the process as it is. */
  discard: () => Promise<void>;
  /** After "Apply": the process is the draft now. */
  reset: () => void;
}

export function useDraft(def: ProcessInfo): DraftState {
  const [spec, setSpec] = useState<ProcessSpec | null>(null);
  const [info, setInfo] = useState<ProcessInfo | null>(null);
  const [loaded, setLoaded] = useState(false);
  const past = useRef<ProcessSpec[]>([]);
  const future = useRef<ProcessSpec[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [, bump] = useState(0);

  useEffect(() => {
    let alive = true;
    void rpc<Draft | null>("process-editor", "draft", { id: def.id })
      .then((draft) => {
        if (!alive) return;
        if (draft?.spec) {
          setSpec(draft.spec);
          void rpc<ProcessInfo>("process-editor", "preview", { id: def.id, spec: draft.spec }).then((x) => alive && setInfo(x)).catch(() => {});
        }
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
    return () => {
      alive = false;
    };
  }, [def.id]);

  const save = useCallback(
    (next: ProcessSpec | null) => {
      clearTimeout(timer.current);
      if (!next) return;
      timer.current = setTimeout(() => {
        void rpc<ProcessInfo>("process-editor", "saveDraft", { id: def.id, spec: next })
          .then(setInfo)
          .catch(() => {});
      }, 250);
    },
    [def.id],
  );

  const current = spec ?? def.spec;
  const apply = (next: ProcessSpec | null) => {
    // Back to the process as it is: no draft.
    const none = !next || sameSpec(next, def.spec);
    setSpec(none ? null : next);
    if (none) {
      setInfo(null);
      clearTimeout(timer.current);
      void rpc("process-editor", "dropDraft", { id: def.id }).catch(() => {});
    } else save(next);
    bump((n) => n + 1);
  };

  const change: DraftState["change"] = (next) => {
    const value = typeof next === "function" ? next(current) : next;
    past.current.push(current);
    future.current = [];
    apply(value);
  };

  return {
    spec: current,
    info: spec && info ? info : def,
    dirty: !!spec,
    diff: diffSpecs(def.spec, current),
    loaded,
    change,
    undo: () => {
      const prev = past.current.pop();
      if (!prev) return;
      future.current.push(current);
      apply(prev);
    },
    redo: () => {
      const next = future.current.pop();
      if (!next) return;
      past.current.push(current);
      apply(next);
    },
    canUndo: past.current.length > 0,
    canRedo: future.current.length > 0,
    discard: async () => {
      past.current.push(current);
      apply(null);
    },
    reset: () => {
      past.current = [];
      future.current = [];
      setSpec(null);
      setInfo(null);
    },
  };
}

/** Applies the draft: the user's own process, or their own version of a plugin's. */
export function applyDraft(id: string, spec: ProcessSpec, note: string): Promise<string | undefined> {
  return attempt(() => rpc<string>("process-editor", "apply", { id, spec, note }));
}
