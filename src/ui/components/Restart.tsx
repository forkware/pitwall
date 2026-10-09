// The banner that says the server runs older code than is on disk, and the restart that waits for the agents.
import { RotateCw, Square } from "lucide-react";
import { api, useUi } from "../api.ts";
import { t } from "../i18n.ts";
import { attempt, Button } from "../kit/index.tsx";
import { selectTask } from "../sdk.tsx";

const bar = "border-b border-line bg-[color-mix(in_srgb,var(--s-amber)_12%,transparent)] px-4 py-1.5 text-xs text-muted";

export function RestartBanner() {
  const stale = useUi((s) => s.serverStale);
  const restartable = useUi((s) => s.data?.app.restartable ?? false);
  const pending = useUi((s) => s.data?.restart != null);
  if (pending) return <Waiting />;
  if (!stale) return null;
  return (
    <div className={`${bar} flex items-center gap-3`}>
      <span className="min-w-0 flex-1">{t(restartable ? "serverStaleRestart" : "serverStale")}</span>
      {restartable && (
        <Button size="sm" icon={RotateCw} onClick={() => void attempt(() => api.post("/api/restart"))}>
          {t("restartWhenDone")}
        </Button>
      )}
    </div>
  );
}

/** The agents still working; the restart goes ahead once none is. */
function Waiting() {
  const busy = useUi((s) => s.data?.sessions.filter((x) => x.busy) ?? []);
  const tasks = useUi((s) => s.data?.tasks ?? []);
  const providers = useUi((s) => s.data?.providers ?? []);
  return (
    <div className={bar}>
      <div className="flex items-center gap-3">
        <span className="min-w-0 flex-1">{t(busy.length ? "restartWaiting" : "restartNow")}</span>
        <Button size="sm" variant="ghost" onClick={() => void attempt(() => api.del("/api/restart"))}>
          {t("cancel")}
        </Button>
      </div>
      {busy.length > 0 && (
        <ul className="mt-1.5 flex flex-col gap-1">
          {busy.map((session) => (
            <li key={session.id} className="flex items-center gap-2">
              <span className="size-1.5 animate-pulse-dot rounded-full bg-[var(--s-green)]" aria-hidden />
              <button className="truncate text-text hover:underline" onClick={() => selectTask(session.taskId)}>
                {tasks.find((x) => x.id === session.taskId)?.title ?? session.taskId}
              </button>
              <span className="text-faint">{providers.find((p) => p.id === session.provider)?.label ?? session.provider}</span>
              <Button
                size="sm"
                variant="ghost"
                icon={Square}
                className="ml-auto"
                // Stopped, not ended: opening its task after the restart continues the conversation.
                onClick={() => void attempt(() => api.post(`/api/sessions/${session.id}/suspend`))}
              >
                {t("kill")}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
