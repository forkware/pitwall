// A table of tasks with picking and actions on the picked ones: a folder's tasks, the archive, search results.
import { ArrowDown, ArrowUp, Archive, ArchiveRestore, FolderInput, Pin, PinOff, Repeat, Trash2, Webhook, X } from "lucide-react";
import { Fragment, useMemo, useRef, useState, type ReactNode } from "react";
import type { Folder, Task } from "../../sdk/types.ts";
import { api, getState, useUi } from "../api.ts";
import { archiveTasks, confirmDeleteForever, restoreTasks } from "../archiveActions.ts";
import { archiveGroup, formatIn, formatWhen, statusLabel, daysUntil } from "../format.ts";
import { t } from "../i18n.ts";
import { attempt, Button, cx, IconButton, Menu, MenuContent, MenuItem, MenuTrigger, StatusDot, toast } from "../kit/index.tsx";
import { openArchivedTask, selectTask } from "../sdk.tsx";

/** A task as a table shows it; the archive and search add what they know. */
export interface TaskRow extends Task {
  /** "Work / Client"; shown when the table spans several folders. */
  folderPath?: string;
  folderDeleted?: boolean;
  /** When a rule deletes it from the archive. */
  deleteAt?: number | null;
  /** A piece of the text that matched a search, with the match between « and ». */
  snippet?: string;
}

export interface TaskTableProps {
  tasks: TaskRow[];
  /** Tasks in the tree, or archived ones: the columns and the actions differ. */
  mode: "active" | "archive";
  /** The folder column, for tables that span folders. */
  showFolder?: boolean;
  /** Archived tasks grouped by when they were archived: Today, This week, … */
  grouped?: boolean;
  /** Above the table, left of the picked count: filters and tabs. */
  toolbar?: ReactNode;
  empty?: ReactNode;
  /** Opens a task; by default the task's page, or the archived one's. */
  onOpen?: (task: TaskRow) => void;
  /** More buttons for the picked tasks. */
  actions?: (picked: TaskRow[]) => ReactNode;
}

type SortKey = "title" | "folder" | "status" | "date" | "deletes";

/** The folders as a flat list, each after its parent, with its depth: for a "Move to" menu. */
export function folderOptions(folders: Folder[]): { folder: Folder; depth: number }[] {
  const out: { folder: Folder; depth: number }[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const f of folders.filter((x) => x.parentId === parentId)) {
      out.push({ folder: f, depth });
      walk(f.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

export function TaskTable({ tasks, mode, showFolder, grouped, toolbar, empty, onOpen, actions }: TaskTableProps) {
  const statuses = useUi((s) => s.data?.statuses ?? []);
  const folders = useUi((s) => s.data?.folders ?? []);
  const automations = useUi((s) => s.data?.automations ?? []);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "date", desc: true });
  const anchor = useRef<string | null>(null);

  const date = (x: TaskRow) => (mode === "archive" ? (x.archivedAt ?? 0) : x.updatedAt);
  const rows = useMemo(() => {
    const order = statuses.map((s) => s.id);
    const value = (x: TaskRow): string | number => {
      switch (sort.key) {
        case "title":
          return x.title.toLowerCase();
        case "folder":
          return (x.folderPath ?? "").toLowerCase();
        case "status":
          return order.indexOf(x.status);
        case "deletes":
          return x.deleteAt ?? Number.MAX_SAFE_INTEGER;
        default:
          return date(x);
      }
    };
    // Grouped by archive date, the groups keep their order.
    const key = grouped ? { key: "date" as const, desc: true } : sort;
    return [...tasks].sort((a, b) => {
      const [va, vb] = key === sort ? [value(a), value(b)] : [date(a), date(b)];
      const c = va < vb ? -1 : va > vb ? 1 : 0;
      return key.desc ? -c : c;
    });
  }, [tasks, sort, grouped, statuses, mode]);

  // Picked tasks that left the table are no longer picked.
  const visible = new Set(rows.map((x) => x.id));
  const pickedRows = rows.filter((x) => picked.has(x.id));
  if ([...picked].some((id) => !visible.has(id))) setPicked(new Set(pickedRows.map((x) => x.id)));

  const open = onOpen ?? ((x: TaskRow) => (x.archivedAt ? openArchivedTask(x.id) : selectTask(x.id)));
  const toggle = (row: TaskRow, range: boolean) => {
    const next = new Set(picked);
    if (range && anchor.current && visible.has(anchor.current)) {
      const ids = rows.map((x) => x.id);
      const [a, b] = [ids.indexOf(anchor.current), ids.indexOf(row.id)].sort((x, y) => x - y);
      for (const id of ids.slice(a, b + 1)) next.add(id);
    } else {
      if (next.has(row.id)) next.delete(row.id);
      else next.add(row.id);
      anchor.current = row.id;
    }
    setPicked(next);
  };
  const all = rows.length > 0 && pickedRows.length === rows.length;
  const clear = () => setPicked(new Set());

  const header = (key: SortKey, label: string, className?: string) => (
    <th className={cx("px-2 py-1.5 text-left font-medium", className)}>
      <button
        className={cx("inline-flex items-center gap-1 hover:text-text", sort.key === key && !grouped && "text-text")}
        onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : key === "date" }))}
      >
        {label}
        {sort.key === key && !grouped && (sort.desc ? <ArrowDown size={11} /> : <ArrowUp size={11} />)}
      </button>
    </th>
  );

  let lastGroup = "";
  return (
    <div
      className="flex min-h-0 flex-1 flex-col outline-none"
      tabIndex={-1}
      onKeyDown={(e) => {
        if ((e.target as HTMLElement).closest("input, textarea, select")) return;
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
          e.preventDefault();
          setPicked(new Set(rows.map((x) => x.id)));
        } else if (e.key === "Escape" && picked.size) {
          e.preventDefault();
          clear();
        } else if ((e.key === "Delete" || ((e.metaKey || e.ctrlKey) && e.key === "Backspace")) && pickedRows.length) {
          e.preventDefault();
          if (mode === "archive" || e.shiftKey) confirmDeleteForever(pickedRows, clear);
          else archiveTasks(pickedRows);
        }
      }}
    >
      {toolbar && <div className="flex shrink-0 flex-wrap items-center gap-2 pb-3">{toolbar}</div>}
      {rows.length === 0 ? (
        (empty ?? <div className="rounded-lg border border-dashed border-line p-8 text-center text-muted">{t("emptyTasks")}</div>)
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-line bg-panel">
          <table className="w-full table-fixed border-collapse text-[13px]">
            <thead className="sticky top-0 z-[1] bg-panel text-[11px] text-faint">
              <tr className="border-b border-line">
                <th className="w-9 px-2 py-1.5">
                  <input
                    type="checkbox"
                    aria-label={t("selectAll")}
                    className="size-3.5 accent-[var(--accent)]"
                    checked={all}
                    onChange={() => setPicked(all ? new Set() : new Set(rows.map((x) => x.id)))}
                  />
                </th>
                {header("title", t("colTitle"))}
                {showFolder && header("folder", t("colFolder"), "w-[22%]")}
                {header("status", t("colStatus"), "w-[16%]")}
                {header("date", mode === "archive" ? t("colArchived") : t("colUpdated"), "w-[14%]")}
                {mode === "archive" && header("deletes", t("colDeletes"), "w-[12%]")}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const status = statuses.find((s) => s.id === row.status);
                const group = grouped ? archiveGroup(date(row)) : "";
                const groupRow = grouped && group !== lastGroup;
                lastGroup = group;
                const auto = row.meta.automation as { id: string; how: string } | undefined;
                const soon = row.deleteAt != null ? daysUntil(row.deleteAt) : null;
                return (
                  <Fragment key={row.id}>
                    {groupRow && (
                      <tr>
                        <td colSpan={6} className="bg-bg/40 px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-[0.06em] text-faint">
                          {group}
                        </td>
                      </tr>
                    )}
                    <tr
                      className={cx(
                        "group cursor-default border-b border-line/60 last:border-0 hover:bg-hover/50",
                        picked.has(row.id) && "bg-[color-mix(in_srgb,var(--accent)_10%,transparent)]",
                      )}
                      onClick={(e) => (e.ctrlKey || e.metaKey || e.shiftKey ? toggle(row, e.shiftKey) : open(row))}
                    >
                      <td className="px-2 py-1.5 text-center" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          aria-label={row.title}
                          className="size-3.5 accent-[var(--accent)]"
                          checked={picked.has(row.id)}
                          onChange={(e) => toggle(row, (e.nativeEvent as MouseEvent).shiftKey)}
                        />
                      </td>
                      <td className="min-w-0 px-2 py-1.5">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <button
                            className="min-w-0 truncate text-left hover:underline"
                            onClick={(e) => (e.stopPropagation(), open(row))}
                            onKeyDown={(e) => e.key === "Enter" && open(row)}
                          >
                            {row.title}
                          </button>
                          {auto && (
                            <span
                              className="shrink-0 text-faint"
                              title={`${automations.find((a) => a.id === auto.id)?.name ?? t("automationGone")} · ${t(`how.${auto.how}`)}`}
                            >
                              {auto.how === "webhook" ? <Webhook size={12} /> : <Repeat size={12} />}
                            </span>
                          )}
                          {row.keep && <Pin size={12} className="shrink-0 text-faint" aria-label={t("kept")} />}
                        </div>
                        {row.snippet && <Snippet text={row.snippet} />}
                      </td>
                      {showFolder && (
                        <td className="truncate px-2 py-1.5 text-xs text-muted" title={row.folderPath}>
                          {row.folderPath}
                          {row.folderDeleted && <span className="text-faint"> · {t("folderDeleted")}</span>}
                        </td>
                      )}
                      <td className="px-2 py-1.5">
                        <span className="inline-flex min-w-0 items-center gap-1.5 text-xs">
                          <StatusDot color={status?.color ?? "gray"} />
                          <span className="truncate">{statusLabel(status, row.status)}</span>
                        </span>
                      </td>
                      <td className="px-2 py-1.5 text-xs text-muted">{formatWhen(date(row))}</td>
                      {mode === "archive" && (
                        <td
                          className={cx(
                            "px-2 py-1.5 text-xs",
                            soon === null ? "text-faint" : soon === 0 ? "text-[var(--danger)]" : soon < 3 ? "text-[var(--s-amber)]" : "text-muted",
                          )}
                        >
                          {row.deleteAt != null ? formatIn(row.deleteAt) : "—"}
                        </td>
                      )}
                    </tr>
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {pickedRows.length > 0 && (
        <div className="mt-3 flex shrink-0 flex-wrap items-center gap-2 rounded-lg border border-line bg-raised px-3 py-2 shadow-lg shadow-black/10">
          <span className="mr-1 text-xs font-medium">{t("pickedCount", { n: pickedRows.length })}</span>
          {mode === "active" ? (
            <>
              <Button size="sm" icon={Archive} onClick={() => archiveTasks(pickedRows)}>
                {t("toArchive")}
              </Button>
              <StatusMenu tasks={pickedRows} />
              <MoveMenu tasks={pickedRows} folders={folders} />
            </>
          ) : (
            <>
              <Button size="sm" icon={ArchiveRestore} onClick={() => void restoreTasks(pickedRows).then((ok) => ok && clear())}>
                {t("restore")}
              </Button>
              <KeepButton tasks={pickedRows} />
            </>
          )}
          {actions?.(pickedRows)}
          <Button size="sm" variant="ghost" icon={Trash2} className="text-[var(--danger)]" onClick={() => confirmDeleteForever(pickedRows, clear)}>
            {t("deleteForever")}
          </Button>
          <IconButton icon={X} label={t("clearPick")} className="ml-auto" onClick={clear} />
        </div>
      )}
    </div>
  );
}

/** A search snippet: the text with the parts between « and » marked. */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/«|»/);
  return (
    <div className="mt-0.5 truncate text-[11px] text-muted">
      {parts.map((part, i) => (i % 2 ? <mark key={i} className="rounded-sm bg-[color-mix(in_srgb,var(--accent)_25%,transparent)] px-0.5 text-text">{part}</mark> : part))}
    </div>
  );
}

function StatusMenu({ tasks }: { tasks: TaskRow[] }) {
  const statuses = useUi((s) => s.data?.statuses ?? []);
  const set = async (status: string) => {
    let failed = 0;
    for (const task of tasks) {
      try {
        await api.patch(`/api/tasks/${task.id}`, { status });
      } catch {
        failed++;
      }
    }
    // A task that follows a process refuses: its process moves it.
    if (failed) toast(t("statusRefused", { n: failed }), "error");
  };
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button size="sm">{t("status")}</Button>
      </MenuTrigger>
      <MenuContent>
        {statuses.map((s) => (
          <MenuItem key={s.id} onSelect={() => void set(s.id)}>
            <StatusDot color={s.color} />
            <span>{statusLabel(s)}</span>
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}

export function MoveMenu({ tasks, folders, compact }: { tasks: Pick<Task, "id">[]; folders: Folder[]; compact?: boolean }) {
  const move = async (folderId: string) => {
    for (const task of tasks) await attempt(() => api.patch(`/api/tasks/${task.id}`, { folderId }));
  };
  return (
    <Menu>
      <MenuTrigger asChild>
        {compact ? <IconButton icon={FolderInput} label={t("moveTo")} /> : <Button size="sm" icon={FolderInput}>{t("move")}</Button>}
      </MenuTrigger>
      <MenuContent>
        <div className="max-h-[50vh] overflow-y-auto">
          {folderOptions(folders).map(({ folder, depth }) => (
            <MenuItem key={folder.id} onSelect={() => void move(folder.id)}>
              <span style={{ paddingLeft: depth * 12 }}>{folder.name}</span>
            </MenuItem>
          ))}
        </div>
      </MenuContent>
    </Menu>
  );
}

function KeepButton({ tasks }: { tasks: TaskRow[] }) {
  const keep = !tasks.every((x) => x.keep);
  return (
    <Button
      size="sm"
      icon={keep ? Pin : PinOff}
      onClick={() => {
        for (const task of tasks) void attempt(() => api.patch(`/api/tasks/${task.id}`, { keep }));
      }}
    >
      {keep ? t("keep") : t("unkeep")}
    </Button>
  );
}

/** Whether a task's status is of the "done" category. */
export function isDone(task: Task): boolean {
  return getState().data?.statuses.find((s) => s.id === task.status)?.category === "done";
}
