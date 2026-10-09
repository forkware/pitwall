// An archived task, read only: what it was, what its agents said, and the way back or out.
import { Archive, ArchiveRestore, FileQuestion, Pin, PinOff, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { ArchivedTask, Session } from "../../sdk/types.ts";
import { api, onEvent, setState, useUi } from "../api.ts";
import { confirmDeleteForever, restoreTasks } from "../archiveActions.ts";
import { archivedByLabel, formatDateTime, statusLabel } from "../format.ts";
import { t } from "../i18n.ts";
import { attempt, Button, cx, EmptyState, StatusDot } from "../kit/index.tsx";
import { selectTask } from "../sdk.tsx";
import { AutomationOrigin } from "./AutomationOrigin.tsx";

export function ArchivedTaskView({ id }: { id: string }) {
  const [task, setTask] = useState<ArchivedTask | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    const load = () =>
      void api
        .get<ArchivedTask | null>(`/api/tasks/${id}`)
        .then((x) => {
          if (!live) return;
          // Restored meanwhile: it is in the tree again.
          if (x && !x.archivedAt) return selectTask(x.id);
          setTask(x);
        })
        .catch(() => live && setTask(null));
    load();
    const off = onEvent((name, payload) => {
      if (/^(task\.|archive\.|settings\.)/.test(name) && (!payload?.id || payload.id === id || name.startsWith("archive") || name.startsWith("settings")))
        load();
    });
    return () => {
      live = false;
      off();
    };
  }, [id]);

  const status = useUi((s) => s.data?.statuses.find((x) => x.id === task?.status));
  const sessions = useUi((s) => s.data?.sessions.filter((x) => x.taskId === id) ?? []);
  const [active, setActive] = useState<string | null>(null);
  const shown = sessions.find((s) => s.id === active) ?? sessions.at(-1);

  if (task === undefined) return null;
  if (task === null)
    return (
      <EmptyState icon={FileQuestion} title={t("taskGone")} body={t("taskGoneBody")}>
        <Button onClick={() => setState({ selection: { kind: "archive" } })}>{t("archive")}</Button>
      </EmptyState>
    );

  const deletes = task.deleteAt ? t("deletesOn", { date: formatDateTime(task.deleteAt) }) : null;
  return (
    <section className="flex h-full min-w-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-raised px-5 py-2 text-xs">
        <Archive size={14} className="shrink-0 text-muted" />
        <span className="text-muted">
          {t("archivedBanner", { date: formatDateTime(task.archivedAt!), by: archivedByLabel(task.archivedBy) })}
          {deletes && <> · {deletes}</>}
          {task.keep && <> · {t("keptNote")}</>}
        </span>
        <span className="ml-auto flex items-center gap-1.5">
          <Button size="sm" variant="primary" icon={ArchiveRestore} onClick={() => void restoreTasks([task], { open: selectTask })}>
            {t("restore")}
          </Button>
          <Button
            size="sm"
            icon={task.keep ? PinOff : Pin}
            onClick={() => void attempt(() => api.patch(`/api/tasks/${task.id}`, { keep: !task.keep }))}
          >
            {task.keep ? t("unkeep") : t("keep")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon={Trash2}
            className="text-[var(--danger)]"
            onClick={() => confirmDeleteForever([task], () => setState({ selection: { kind: "archive" } }))}
          >
            {t("deleteForever")}
          </Button>
        </span>
      </div>
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-5">
        <div className="min-w-0">
          <div className="truncate text-[11px] text-faint">
            {task.folderPath}
            {task.folderDeleted && ` · ${t("folderDeleted")}`}
          </div>
          <h1 className="truncate text-[15px] font-semibold leading-tight">{task.title}</h1>
        </div>
        <span className="inline-flex h-7 shrink-0 items-center gap-2 rounded-full border border-line px-2.5 text-xs font-medium">
          <StatusDot color={status?.color ?? "gray"} />
          {statusLabel(status, task.status)}
        </span>
      </header>
      <AutomationOrigin task={task} />
      {task.body && (
        <div className="max-h-40 shrink-0 overflow-y-auto whitespace-pre-wrap border-b border-line px-5 py-3 text-[13px] text-muted">
          {task.body}
        </div>
      )}
      {sessions.length === 0 ? (
        <EmptyState icon={Archive} title={t("noSessionsArchived")} />
      ) : (
        <>
          <div role="tablist" className="flex h-9 shrink-0 items-end gap-1 overflow-x-auto border-b border-line px-3">
            {sessions.map((s, i) => (
              <button
                key={s.id}
                role="tab"
                aria-selected={s.id === shown?.id}
                onClick={() => setActive(s.id)}
                className={cx(
                  "relative h-8 rounded-t-md px-3 text-xs font-medium",
                  s.id === shown?.id ? "bg-bg text-text" : "text-muted hover:text-text",
                )}
              >
                {s.provider} <span className="text-faint">#{i + 1}</span>
              </button>
            ))}
          </div>
          {shown && <SessionLog session={shown} />}
        </>
      )}
    </section>
  );
}

/** What an ended agent printed, as text. */
function SessionLog({ session }: { session: Session }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    setText(null);
    void api
      .get<{ text: string }>(`/api/sessions/${session.id}/log`)
      .then((x) => setText(x.text))
      .catch(() => setText(""));
  }, [session.id]);
  return (
    <div className="min-h-0 flex-1 overflow-auto bg-bg">
      <pre className="whitespace-pre-wrap break-words px-5 py-3 font-mono text-[12px] leading-[1.45] text-muted">
        {text === null ? t("loadingOutput") : text.trim() || "—"}
      </pre>
    </div>
  );
}
