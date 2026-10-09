// The archive: the whole of it, or a folder's; restored or deleted from here, by hand or by the rules.
import { Archive as ArchiveIcon, ArchiveX, Clock } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ArchivedTask, Deletion } from "../../sdk/types.ts";
import { api, onEvent, useUi } from "../api.ts";
import { confirmDeleteForever } from "../archiveActions.ts";
import { formatDateTime } from "../format.ts";
import { t } from "../i18n.ts";
import { Button, cx, Dialog, EmptyState, Input, showCustomDialog } from "../kit/index.tsx";
import { folderOptions, TaskTable } from "./TaskTable.tsx";

const WEEK = 7 * 24 * 60 * 60 * 1000;

/** The archived tasks, fetched again whenever tasks change. */
export function useArchive(folderId?: string): ArchivedTask[] | null {
  const [tasks, setTasks] = useState<ArchivedTask[] | null>(null);
  useEffect(() => {
    let live = true;
    const load = () =>
      void api
        .get<ArchivedTask[]>(`/api/archive${folderId ? `?folderId=${encodeURIComponent(folderId)}` : ""}`)
        .then((list) => live && setTasks(list))
        .catch(() => live && setTasks([]));
    load();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = onEvent((name) => {
      if (!/^(task\.|archive\.|folder\.|settings\.|automation\.)/.test(name)) return;
      clearTimeout(timer);
      timer = setTimeout(load, 60);
    });
    return () => {
      live = false;
      off();
      clearTimeout(timer);
    };
  }, [folderId]);
  return tasks;
}

type Source = "" | "user" | "rule" | "folder" | "automation";

/** The archive's table with its filters; `folderId` narrows it to a folder and its subfolders. */
export function ArchiveList({ folderId, toolbar }: { folderId?: string; toolbar?: React.ReactNode }) {
  const all = useArchive(folderId);
  const folders = useUi((s) => s.data?.folders ?? []);
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<Source>("");
  const [soon, setSoon] = useState(false);
  const [inFolder, setInFolder] = useState("");

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const now = Date.now();
    const under = inFolder ? subtree(folders, inFolder) : null;
    return (all ?? []).filter((x) => {
      if (q && !x.title.toLowerCase().includes(q) && !x.folderPath.toLowerCase().includes(q)) return false;
      if (source && !(source === "automation" ? x.archivedBy?.startsWith("automation:") : x.archivedBy === source)) return false;
      if (soon && !(x.deleteAt !== null && x.deleteAt <= now + WEEK)) return false;
      if (under && !under.has(x.folderId)) return false;
      return true;
    });
  }, [all, query, source, soon, inFolder, folders]);

  if (all === null) return null;
  const dueSoon = all.filter((x) => x.deleteAt !== null && x.deleteAt <= Date.now() + WEEK).length;
  const filtered = shown.length !== all.length;

  if (all.length === 0)
    return (
      <>
        {toolbar && <div className="flex flex-wrap items-center gap-2 pb-3">{toolbar}</div>}
        <EmptyState icon={ArchiveIcon} title={t("emptyArchiveTitle")} body={t("emptyArchiveBody")} />
        <DeletionsLink />
      </>
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {dueSoon > 0 && (
        <div className="mb-3 flex items-center gap-2 rounded-lg border border-[color-mix(in_srgb,var(--s-amber)_40%,transparent)] bg-[color-mix(in_srgb,var(--s-amber)_10%,transparent)] px-3 py-2 text-xs">
          <Clock size={13} className="shrink-0 text-[var(--s-amber)]" />
          <span>{t("dueSoon", { n: dueSoon })}</span>
          <button className="font-medium text-accent hover:underline" onClick={() => setSoon(true)}>
            {t("show")}
          </button>
        </div>
      )}
      <TaskTable
        tasks={shown}
        mode="archive"
        showFolder
        grouped
        toolbar={
          <>
            {toolbar}
            <Input className="h-8 !w-56" placeholder={t("filterPlaceholder")} value={query} onChange={(e) => setQuery(e.target.value)} />
            {!folderId && (
              <select className={select} value={inFolder} onChange={(e) => setInFolder(e.target.value)} aria-label={t("colFolder")}>
                <option value="">{t("allArchive")}</option>
                {folderOptions(folders).map(({ folder, depth }) => (
                  <option key={folder.id} value={folder.id}>
                    {" ".repeat(depth * 2)}
                    {folder.name}
                  </option>
                ))}
              </select>
            )}
            <select className={select} value={source} onChange={(e) => setSource(e.target.value as Source)} aria-label={t("sourceAny")}>
              <option value="">{t("sourceAny")}</option>
              {(["user", "rule", "folder", "automation"] as const).map((s) => (
                <option key={s} value={s}>
                  {t(`archivedBy.${s}`)}
                </option>
              ))}
            </select>
            <label className="flex h-8 items-center gap-1.5 text-xs text-muted">
              <input type="checkbox" className="size-3.5 accent-[var(--accent)]" checked={soon} onChange={(e) => setSoon(e.target.checked)} />
              {t("dueSoonFilter")}
            </label>
            <Button
              size="sm"
              variant="ghost"
              icon={ArchiveX}
              className="ml-auto text-[var(--danger)]"
              disabled={shown.length === 0}
              onClick={() => confirmDeleteForever(shown)}
            >
              {filtered ? t("deleteFound", { n: shown.length }) : t("clearArchive")}
            </Button>
          </>
        }
      />
      <DeletionsLink />
    </div>
  );
}

function subtree(folders: { id: string; parentId: string | null }[], id: string): Set<string> {
  const ids = new Set([id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const f of folders) if (f.parentId && ids.has(f.parentId) && !ids.has(f.id)) (ids.add(f.id), (grew = true));
  }
  return ids;
}

const select =
  "h-8 rounded-md border border-line bg-bg px-2 text-xs outline-none focus:border-accent";

/** "Deleted by rules in 30 days: N": opens the names of what the rules deleted. */
function DeletionsLink() {
  const [list, setList] = useState<Deletion[]>([]);
  useEffect(() => {
    const load = () =>
      void api
        .get<Deletion[]>(`/api/archive/deletions?since=${Date.now() - 30 * 24 * 60 * 60 * 1000}`)
        .then(setList)
        .catch(() => {});
    load();
    return onEvent((name) => name === "archive.swept" && load());
  }, []);
  if (list.length === 0) return null;
  return (
    <button
      className="mt-3 self-start text-xs text-muted underline decoration-line underline-offset-2 hover:text-text"
      onClick={() =>
        showCustomDialog(({ open, onOpenChange }) => (
          <Dialog open={open} onOpenChange={onOpenChange} title={t("deletionsTitle")} description={t("deletionsBody")}>
            <ul className="max-h-[50vh] divide-y divide-line overflow-y-auto rounded-md border border-line">
              {list.map((d) => (
                <li key={`${d.taskId}-${d.at}`} className="px-3 py-2">
                  <div className="truncate text-[13px]">{d.title}</div>
                  <div className="text-[11px] text-faint">
                    {d.folder} · {formatDateTime(d.at)} · {t(`rule.${d.rule}`)}
                  </div>
                </li>
              ))}
            </ul>
          </Dialog>
        ))
      }
    >
      {t("deletionsLink", { n: list.length })}
    </button>
  );
}

/** The archive in the main panel. */
export function ArchivePage({ folderId }: { folderId?: string }) {
  const folder = useUi((s) => (folderId ? s.data?.folders.find((f) => f.id === folderId) : undefined));
  return (
    <section className="flex h-full min-w-0 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-5">
        <ArchiveIcon size={16} className="shrink-0 text-muted" strokeWidth={1.75} />
        <h1 className={cx("truncate text-[15px] font-semibold leading-tight")}>
          {folder ? t("archiveOf", { folder: folder.name }) : t("archive")}
        </h1>
      </header>
      <div className="flex min-h-0 flex-1 flex-col px-6 py-5">
        <ArchiveList folderId={folderId} />
      </div>
    </section>
  );
}
