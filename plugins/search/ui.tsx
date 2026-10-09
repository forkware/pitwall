import { Archive, ArrowRight, CornerDownLeft, Folder as FolderIcon, Search, Terminal } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  addStrings,
  allCommands,
  cx,
  defineUiPlugin,
  Dialog,
  formatKeys,
  getState,
  Input,
  openPage,
  openTask,
  rpc,
  selectFolder,
  showCustomDialog,
  statusLabel,
  StatusDot,
  t,
  TaskTable,
  useUi,
  type Command,
  type PageProps,
  type Task,
  type TaskRow,
} from "#sdk/ui";
import type { SearchInput, SearchResult } from "./search.ts";

addStrings({
  en: {
    "search.button": "Search…",
    "search.placeholder": "Search tasks and commands",
    "search.tasks": "Tasks",
    "search.recent": "Recent",
    "search.folders": "Folders",
    "search.commands": "Commands",
    "search.all": "All results",
    "search.archived": "in the archive",
    "search.alsoArchive": "In the archive too: {n}",
    "search.nothing": "Nothing found",
    "search.inArchive": "Nothing found here. In the archive: {n}",
    "search.title": "Search",
    "search.query": "Words, or in:folder status:done is:waiting from:webhook created:7d",
    "search.folder": "Any folder",
    "search.status": "Any status",
    "search.process": "Any process",
    "search.source": "Any source",
    "search.manual": "By hand",
    "search.schedule": "By schedule",
    "search.webhook": "By webhook",
    "search.state": "Any state",
    "search.waiting": "Waits for an answer",
    "search.asking": "The agent asks",
    "search.failed": "Process failed",
    "search.working": "The agent works",
    "search.date": "Any time",
    "search.days": "Changed in {n} days",
    "search.active": "Without the archive",
    "search.allTasks": "With the archive",
    "search.onlyArchived": "Only the archive",
    "search.logs": "Search the agents' conversations",
    "search.found": "Found: {n}",
    "search.archivedTasks": "In the archive",
    "search.show": "Show",
    "search.cmd": "Search tasks",
  },
  ru: {
    "search.button": "Поиск…",
    "search.placeholder": "Поиск задач и команд",
    "search.tasks": "Задачи",
    "search.recent": "Недавние",
    "search.folders": "Папки",
    "search.commands": "Команды",
    "search.all": "Все результаты",
    "search.archived": "в архиве",
    "search.alsoArchive": "Ещё в архиве: {n}",
    "search.nothing": "Ничего не найдено",
    "search.inArchive": "Здесь ничего не найдено. В архиве: {n}",
    "search.title": "Поиск",
    "search.query": "Слова или in:папка status:done is:waiting from:webhook created:7d",
    "search.folder": "Любая папка",
    "search.status": "Любой статус",
    "search.process": "Любой процесс",
    "search.source": "Любой источник",
    "search.manual": "Вручную",
    "search.schedule": "По расписанию",
    "search.webhook": "Вебхуком",
    "search.state": "Любое состояние",
    "search.waiting": "Ждут ответа",
    "search.asking": "Агент спрашивает",
    "search.failed": "Процесс упал",
    "search.working": "Агент работает",
    "search.date": "За всё время",
    "search.days": "Изменены за {n} дн.",
    "search.active": "Без архива",
    "search.allTasks": "Вместе с архивом",
    "search.onlyArchived": "Только архив",
    "search.logs": "Искать в переписке агентов",
    "search.found": "Найдено: {n}",
    "search.archivedTasks": "В архиве",
    "search.show": "Показать",
    "search.cmd": "Искать задачи",
  },
});

const PLUGIN = "search";

// Recently opened tasks, for the palette with nothing typed.

const RECENT_KEY = "search.recent";

function recent(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function remember(id: string): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...recent().filter((x) => x !== id)].slice(0, 20)));
  } catch {}
}

/** In the sidebar: the search field that opens the palette, and the memory of opened tasks. */
function SearchButton() {
  const open = useUi((s) => (s.selection?.kind === "task" ? s.selection.id : null));
  useEffect(() => {
    if (open) remember(open);
  }, [open]);
  return (
    <div className="px-2 pb-2">
      <button
        onClick={openPalette}
        className="flex h-8 w-full items-center gap-2 rounded-md border border-line bg-bg px-2.5 text-[13px] text-faint transition-colors hover:border-accent/50 hover:text-muted"
      >
        <Search size={14} />
        {t("search.button")}
        <kbd className="ml-auto rounded bg-raised px-1.5 text-[10px] font-medium">{formatKeys("Mod+K", /mac/i.test(navigator.platform))}</kbd>
      </button>
    </div>
  );
}

// The palette

type Item =
  | { kind: "task"; task: Task & { folderPath?: string }; snippet: string | null }
  | { kind: "folder"; id: string; name: string; path: string }
  | { kind: "command"; command: Command }
  | { kind: "all"; n: number };

export function openPalette(): void {
  showCustomDialog(({ open, onOpenChange }) => (
    <Dialog open={open} onOpenChange={onOpenChange} wide title={t("search.title")}>
      <Palette close={() => onOpenChange(false)} />
    </Dialog>
  ));
}

/** The command's target, when it needs one: the open task, or the open folder (the open task's folder). */
function commandTarget(command: Command): (() => void) | null {
  const { selection, data } = getState();
  const task = selection?.kind === "task" ? data?.tasks.find((x) => x.id === selection.id) : undefined;
  const folderId = selection?.kind === "folder" ? selection.id : task?.folderId;
  const folder = data?.folders.find((f) => f.id === folderId);
  if (command.scope === "task") return task ? () => command.run(task) : null;
  if (command.scope === "folder") return folder ? () => command.run(folder) : null;
  return () => (command.run as () => void)();
}

function Palette({ close }: { close: () => void }) {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<SearchResult | null>(null);
  const [active, setActive] = useState(0);
  const folders = useUi((s) => s.data?.folders ?? []);
  const tasks = useUi((s) => s.data?.tasks ?? []);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const q = query.trim();
    if (!q) return setResult(null);
    let live = true;
    const timer = setTimeout(
      () =>
        void rpc<SearchResult>(PLUGIN, "search", { query: q, archive: "all", limit: 8 } satisfies SearchInput)
          .then((r) => live && setResult(r))
          .catch(() => {}),
      120,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query]);

  const items = useMemo<Item[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      const byId = new Map(tasks.map((x) => [x.id, x]));
      return recent()
        .map((id) => byId.get(id))
        .filter((x): x is Task => !!x)
        .slice(0, 8)
        .map((task) => ({ kind: "task" as const, task, snippet: null }));
    }
    const words = q.split(/\s+/).filter((w) => !w.includes(":"));
    const matches = (text: string) => words.length > 0 && words.every((w) => text.toLowerCase().includes(w));
    // Archived tasks go last: found, but after what is in the tree.
    const hits = [...(result?.hits ?? [])].sort((a, b) => Number(!!a.task.archivedAt) - Number(!!b.task.archivedAt));
    const out: Item[] = hits.map((h) => ({ kind: "task", task: h.task, snippet: h.snippet }));
    for (const f of folders.filter((f) => matches(f.name)).slice(0, 4)) {
      const path: string[] = [];
      for (let p = folders.find((x) => x.id === f.parentId); p; p = folders.find((x) => x.id === p!.parentId)) path.unshift(p.name);
      out.push({ kind: "folder", id: f.id, name: f.name, path: path.join(" / ") });
    }
    for (const c of allCommands().filter((c) => matches([c.label, ...(c.keywords ?? [])].join(" ")) && commandTarget(c)).slice(0, 5))
      out.push({ kind: "command", command: c });
    out.push({ kind: "all", n: result?.hits.length ?? 0 });
    return out;
  }, [query, result, folders, tasks]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const all = () => {
    close();
    openPage(PLUGIN, "results", { query: query.trim() });
  };
  const run = (item: Item | undefined) => {
    if (!item) return;
    close();
    if (item.kind === "task") {
      remember(item.task.id);
      void openTask(item.task.id);
    } else if (item.kind === "folder") selectFolder(item.id);
    else if (item.kind === "command") commandTarget(item.command)?.();
    else openPage(PLUGIN, "results", { query: query.trim() });
  };

  let section = "";
  const heading = (kind: Item["kind"]) => {
    const name = kind === "task" ? (query.trim() ? t("search.tasks") : t("search.recent")) : kind === "folder" ? t("search.folders") : kind === "command" ? t("search.commands") : "";
    if (!name || name === section) return null;
    section = name;
    return <div className="px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-faint">{name}</div>;
  };

  return (
    <div className="-mt-2">
      <Input
        autoFocus
        className="h-10 text-[14px]"
        placeholder={t("search.placeholder")}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") (e.preventDefault(), setActive((i) => Math.min(items.length - 1, i + 1)));
          else if (e.key === "ArrowUp") (e.preventDefault(), setActive((i) => Math.max(0, i - 1)));
          else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) (e.preventDefault(), all());
          else if (e.key === "Enter") (e.preventDefault(), run(items[active]));
        }}
      />
      <div ref={list} className="mt-2 max-h-[55vh] overflow-y-auto">
        {items.length === 0 && query.trim() && <div className="px-2 py-6 text-center text-muted">{t("search.nothing")}</div>}
        {items.map((item, i) => (
          <div key={i}>
            {heading(item.kind)}
            <button
              data-index={i}
              onMouseMove={() => setActive(i)}
              onClick={() => run(item)}
              className={cx(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px]",
                i === active ? "bg-hover text-text" : "text-text/90",
              )}
            >
              <ItemView item={item} />
              {i === active && <CornerDownLeft size={12} className="ml-auto shrink-0 text-faint" />}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function ItemView({ item }: { item: Item }) {
  const statuses = useUi((s) => s.data?.statuses ?? []);
  if (item.kind === "task") {
    const status = statuses.find((s) => s.id === item.task.status);
    return (
      <span className="flex min-w-0 flex-1 items-center gap-2">
        {item.task.archivedAt ? <Archive size={12} className="shrink-0 text-faint" /> : <StatusDot color={status?.color ?? "gray"} />}
        <span className="min-w-0 flex-1">
          <span className="block truncate">
            {item.task.title}
            {item.task.archivedAt && <span className="text-faint"> · {t("search.archived")}</span>}
          </span>
          {item.snippet && <span className="block truncate text-[11px] text-muted">{item.snippet.replace(/[«»]/g, "")}</span>}
        </span>
        {item.task.folderPath && <span className="max-w-[35%] shrink-0 truncate text-xs text-faint">{item.task.folderPath}</span>}
      </span>
    );
  }
  if (item.kind === "folder")
    return (
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <FolderIcon size={13} className="shrink-0 text-muted" />
        <span className="truncate">{item.name}</span>
        {item.path && <span className="truncate text-xs text-faint">{item.path}</span>}
      </span>
    );
  if (item.kind === "command") {
    const Icon = item.command.icon ?? Terminal;
    return (
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <Icon size={13} className="shrink-0 text-muted" />
        <span className="truncate">{item.command.label}</span>
      </span>
    );
  }
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2 text-accent">
      <ArrowRight size={13} className="shrink-0" />
      {t("search.all")}
      <span className="text-xs text-faint">{formatKeys("Mod+Enter", /mac/i.test(navigator.platform))}</span>
    </span>
  );
}

// The page of results

const field = "h-8 rounded-md border border-line bg-bg px-2 text-xs outline-none focus:border-accent";

function ResultsPage({ params }: PageProps) {
  const [query, setQuery] = useState(String(params.query ?? ""));
  const [f, setF] = useState<SearchInput>({ archive: "active" });
  const [result, setResult] = useState<SearchResult | null>(null);
  const folders = useUi((s) => s.data?.folders ?? []);
  const statuses = useUi((s) => s.data?.statuses ?? []);
  const processes = useUi((s) => s.data?.processes.defs ?? []);
  const automations = useUi((s) => s.data?.automations ?? []);
  const version = useUi((s) => s.data);

  useEffect(() => setQuery(String(params.query ?? "")), [params.query]);
  useEffect(() => {
    let live = true;
    const timer = setTimeout(
      () =>
        void rpc<SearchResult>(PLUGIN, "search", { ...f, query, limit: 300 })
          .then((r) => live && setResult(r))
          .catch(() => {}),
      150,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // The state changes when tasks do: search again.
  }, [query, f, version]);

  const set = <K extends keyof SearchInput>(key: K, value: SearchInput[K] | "") =>
    setF((x) => ({ ...x, [key]: value === "" ? undefined : value }));
  const rows = (result?.hits ?? []).map((h) => ({ ...h.task, snippet: h.snippet ?? undefined }) as TaskRow);
  const active = rows.filter((x) => !x.archivedAt);
  const archived = rows.filter((x) => x.archivedAt);
  const depth = (id: string | null): number => {
    const p = folders.find((x) => x.id === id);
    return p ? 1 + depth(p.parentId) : 0;
  };

  return (
    <section className="flex h-full min-w-0 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-5">
        <Search size={16} className="shrink-0 text-muted" strokeWidth={1.75} />
        <h1 className="text-[15px] font-semibold">{t("search.title")}</h1>
        {result && <span className="text-xs text-faint">{t("search.found", { n: rows.length })}</span>}
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-6 py-5">
        <Input autoFocus className="h-9" placeholder={t("search.query")} value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="flex flex-wrap items-center gap-2">
          <select className={field} value={f.folderId ?? ""} onChange={(e) => set("folderId", e.target.value)}>
            <option value="">{t("search.folder")}</option>
            {folders.map((x) => (
              <option key={x.id} value={x.id}>
                {" ".repeat(depth(x.parentId) * 2)}
                {x.name}
              </option>
            ))}
          </select>
          <select className={field} value={f.status ?? ""} onChange={(e) => set("status", e.target.value)}>
            <option value="">{t("search.status")}</option>
            {statuses.map((s) => (
              <option key={s.id} value={s.id}>
                {statusLabel(s)}
              </option>
            ))}
          </select>
          <select className={field} value={f.process ?? ""} onChange={(e) => set("process", e.target.value)}>
            <option value="">{t("search.process")}</option>
            {processes.map((w) => (
              <option key={w.id} value={w.id}>
                {w.label}
              </option>
            ))}
          </select>
          <select className={field} value={f.source ?? ""} onChange={(e) => set("source", e.target.value)}>
            <option value="">{t("search.source")}</option>
            <option value="manual">{t("search.manual")}</option>
            <option value="schedule">{t("search.schedule")}</option>
            <option value="webhook">{t("search.webhook")}</option>
            {automations.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <select className={field} value={f.state ?? ""} onChange={(e) => set("state", e.target.value as SearchInput["state"])}>
            <option value="">{t("search.state")}</option>
            {(["waiting", "asking", "failed", "working"] as const).map((s) => (
              <option key={s} value={s}>
                {t(`search.${s}`)}
              </option>
            ))}
          </select>
          <select className={field} value={f.updated ?? ""} onChange={(e) => set("updated", e.target.value ? Number(e.target.value) : "")}>
            <option value="">{t("search.date")}</option>
            {[1, 7, 30, 90].map((n) => (
              <option key={n} value={n}>
                {t("search.days", { n })}
              </option>
            ))}
          </select>
          <select className={field} value={f.archive ?? "active"} onChange={(e) => set("archive", e.target.value as SearchInput["archive"])}>
            <option value="active">{t("search.active")}</option>
            <option value="all">{t("search.allTasks")}</option>
            <option value="archived">{t("search.onlyArchived")}</option>
          </select>
          <label className="flex items-center gap-1.5 text-xs text-muted">
            <input type="checkbox" className="size-3.5 accent-[var(--accent)]" checked={!!f.logs} onChange={(e) => set("logs", e.target.checked)} />
            {t("search.logs")}
          </label>
        </div>
        {result && rows.length === 0 && result.archived > 0 ? (
          <div className="rounded-lg border border-dashed border-line p-6 text-center text-muted">
            {t("search.inArchive", { n: result.archived })}{" "}
            <button className="font-medium text-accent hover:underline" onClick={() => set("archive", "all")}>
              {t("search.show")}
            </button>
          </div>
        ) : (
          <>
            {(active.length > 0 || archived.length === 0) && (
              <TaskTable tasks={active} mode="active" showFolder empty={<div className="rounded-lg border border-dashed border-line p-6 text-center text-muted">{t("search.nothing")}</div>} />
            )}
            {archived.length > 0 && (
              <>
                {active.length > 0 && <h2 className="pt-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-faint">{t("search.archivedTasks")}</h2>}
                <TaskTable tasks={archived} mode="archive" showFolder />
              </>
            )}
            {result && result.archived > 0 && f.archive === "active" && rows.length > 0 && (
              <div className="text-xs text-muted">
                {t("search.alsoArchive", { n: result.archived })}{" "}
                <button className="font-medium text-accent hover:underline" onClick={() => set("archive", "all")}>
                  {t("search.show")}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

export default defineUiPlugin({
  slots: { "sidebar.header": SearchButton },
  pages: { results: ResultsPage },
  shortcuts: [
    // Not in fields and terminals: Ctrl+K there is the shell's own key.
    { command: "search", keys: "Mod+K", run: openPalette },
    { command: "searchPage", keys: "Mod+Shift+F", run: () => openPage(PLUGIN, "results", {}) },
  ],
  commands: [{ id: "search.page", label: t("search.cmd"), icon: Search, run: () => openPage(PLUGIN, "results", {}) }],
});

