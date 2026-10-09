// A process's history: each version that was saved, newest first, with what was asked for, to compare and bring back.
import { useEffect, useState } from "react";
import { Button, formatDateTime, onEvent, rpc, t, type ProcessInfo, type ProcessSpec, type ProcessVersion } from "#sdk/ui";
import { openDiff } from "./DiffRecipe.tsx";
import { MINE_PLUGIN } from "./ids.ts";

export function useVersions(id: string): ProcessVersion[] {
  const [versions, setVersions] = useState<ProcessVersion[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => void rpc<ProcessVersion[]>("process-editor", "versions", { id }).then((v) => alive && setVersions(v)).catch(() => {});
    load();
    const off = onEvent((name) => name === "process.registered" && load());
    return () => {
      alive = false;
      off();
    };
  }, [id]);
  return versions;
}

export function History({ def, onRestore }: { def: ProcessInfo; onRestore: (spec: ProcessSpec) => void }) {
  const versions = useVersions(def.id).filter((v) => v.note !== "draft");
  if (!versions.length) return <p className="px-6 py-5 text-muted">{t("we.history.empty")}</p>;
  return (
    <div className="max-w-3xl px-4 py-4 sm:px-6">
      <p className="mb-4 text-muted">{t("we.history.hint")}</p>
      <ol className="divide-y divide-line rounded-lg border border-line bg-panel">
        {versions.map((v) => {
          const current = v.version === def.version;
          const yours = v.spec.overrides !== undefined || (def.plugin === MINE_PLUGIN && !def.original);
          return (
            <li key={v.version} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{formatDateTime(v.at)}</span>
                  <span className="text-xs text-muted">{yours ? t("we.history.yours") : t("we.history.plugin")}</span>
                  {current && <span className="rounded bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] px-1.5 text-[11px] text-accent">{t("we.history.current")}</span>}
                </div>
                {v.note && <div className="text-xs text-muted">{v.note}</div>}
              </div>
              {!current && (
                <>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      openDiff({
                        title: t("we.history.compareTitle", { when: formatDateTime(v.at) }),
                        before: v.spec,
                        after: def.spec,
                        info: def,
                      })
                    }
                  >
                    {t("we.history.compare")}
                  </Button>
                  <Button size="sm" onClick={() => onRestore(v.spec)}>
                    {t("we.history.restore")}
                  </Button>
                </>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
