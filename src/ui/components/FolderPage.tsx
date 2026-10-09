// A folder's page: its tasks (with the archive), its automations and its settings, in tabs.
import { FolderOpen } from "lucide-react";
import { useMemo, useState } from "react";
import type { Folder } from "../../sdk/types.ts";
import { setState, useUi } from "../api.ts";
import { t } from "../i18n.ts";
import { cx, Input } from "../kit/index.tsx";
import { ArchiveList } from "./ArchiveView.tsx";
import { AutomationList } from "./AutomationsView.tsx";
import { FolderSettings } from "./Settings.tsx";
import { TaskTable, type TaskRow } from "./TaskTable.tsx";

export function FolderPage({ folder }: { folder: Folder }) {
  const tab = useUi((s) => s.folderTab);
  const path = useUi((s) => {
    const names: string[] = [];
    for (let f = s.data?.folders.find((x) => x.id === folder.parentId); f; f = s.data?.folders.find((x) => x.id === f!.parentId))
      names.unshift(f.name);
    return names.join(" / ");
  });
  const automations = useUi((s) => s.data?.automations.filter((a) => a.folderId === folder.id).length ?? 0);
  const tabs = [
    ["tasks", t("tabTasks")],
    ["automations", automations ? `${t("tabAutomations")} ${automations}` : t("tabAutomations")],
    ["settings", t("tabSettings")],
  ] as const;
  return (
    <section className="flex h-full min-w-0 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-5">
        <FolderOpen size={16} className="shrink-0 text-muted" strokeWidth={1.75} />
        <div className="min-w-0">
          {path && <div className="truncate text-[11px] text-faint">{path}</div>}
          <h1 className="truncate text-[15px] font-semibold leading-tight">{folder.name}</h1>
        </div>
        <nav role="tablist" className="ml-6 flex h-full items-end gap-1">
          {tabs.map(([id, label]) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              onClick={() => setState({ folderTab: id })}
              className={cx(
                "relative h-10 px-3 text-[13px] font-medium transition-colors",
                tab === id ? "text-text" : "text-muted hover:text-text",
              )}
            >
              {label}
              {tab === id && <span className="absolute inset-x-2 bottom-0 h-[2px] rounded-full bg-accent" />}
            </button>
          ))}
        </nav>
      </header>
      <div className={cx("flex min-h-0 flex-1 flex-col px-6 py-5", tab === "settings" && "overflow-y-auto")}>
        {tab === "tasks" && <FolderTasks folder={folder} />}
        {tab === "automations" && <AutomationList folderId={folder.id} />}
        {tab === "settings" && <FolderSettings folder={folder} />}
      </div>
    </section>
  );
}

type Show = "active" | "done" | "archive";

function FolderTasks({ folder }: { folder: Folder }) {
  const [show, setShow] = useState<Show>("active");
  const [query, setQuery] = useState("");
  const data = useUi((s) => s.data);
  const { rows, nested } = useMemo(() => {
    const folders = data?.folders ?? [];
    const ids = new Set([folder.id]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const f of folders) if (f.parentId && ids.has(f.parentId) && !ids.has(f.id)) (ids.add(f.id), (grew = true));
    }
    const path = (id: string) => {
      const names: string[] = [];
      for (let f = folders.find((x) => x.id === id); f && f.id !== folder.parentId; f = folders.find((x) => x.id === f!.parentId)) names.unshift(f.name);
      return names.join(" / ");
    };
    const done = new Set(data?.statuses.filter((s) => s.category === "done").map((s) => s.id));
    const q = query.trim().toLowerCase();
    const rows: TaskRow[] = (data?.tasks ?? [])
      .filter((x) => ids.has(x.folderId) && !x.meta?.trial && done.has(x.status) === (show === "done"))
      .filter((x) => !q || x.title.toLowerCase().includes(q))
      .map((x) => ({ ...x, folderPath: path(x.folderId) }));
    return { rows, nested: ids.size > 1 };
  }, [data, folder, show, query]);

  const switcher = (
    <div className="flex rounded-md border border-line p-0.5">
      {(["active", "done", "archive"] as const).map((id) => (
        <button
          key={id}
          onClick={() => setShow(id)}
          className={cx("h-6 rounded px-2.5 text-xs font-medium", show === id ? "bg-hover text-text" : "text-muted hover:text-text")}
        >
          {t(id === "active" ? "tabActive" : id === "done" ? "tabDone" : "tabArchive")}
        </button>
      ))}
    </div>
  );
  if (show === "archive") return <ArchiveList folderId={folder.id} toolbar={switcher} />;
  return (
    <TaskTable
      tasks={rows}
      mode="active"
      showFolder={nested}
      toolbar={
        <>
          {switcher}
          <Input className="h-8 !w-56" placeholder={t("filterPlaceholder")} value={query} onChange={(e) => setQuery(e.target.value)} />
        </>
      }
    />
  );
}
