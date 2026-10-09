import {
  Archive,
  ArchiveRestore,
  ChevronRight,
  CircleAlert,
  Repeat,
  Webhook,
  X,
  Folder as FolderIcon,
  FolderOpen,
  FolderPlus,
  Hand,
  LoaderCircle,
  MessageCircleQuestion,
  MoreHorizontal,
  Pencil,
  Play,
  Pause,
  Trash2,
} from "lucide-react";
import type { Automation } from "../../sdk/types.ts";
import { archiveTasks, confirmDeleteForever, doneUnder } from "../archiveActions.ts";
import { formatIn } from "../format.ts";
import { MoveMenu } from "./TaskTable.tsx";
import { openAutomationDialog, runNow, setPaused, TriggerIcon } from "./AutomationsView.tsx";
import { useEffect, useRef, useState } from "react";
import type { Folder, Task } from "../../sdk/types.ts";
import { api, getState, setState, useUi } from "../api.ts";
import { FolderTaskButtons, FolderTaskMenuItems, openNewFolderDialog } from "./FolderProcesses.tsx";
import { t } from "../i18n.ts";
import {
  attempt,
  Button,
  cx,
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  StatusDot,
} from "../kit/index.tsx";
import { confirmDeleteFolder, openArchive, openAutomations, selectAutomation, selectFolder, selectTask, startRename } from "../sdk.tsx";
import { shortcutHint } from "../shortcuts.ts";
import { Slot, useSlotFilled } from "../slots.tsx";
import { folderSections, needingUser } from "../tree.ts";
import { onTreeSpace, rowArrow, rowContextMenu } from "../treeKeys.ts";

export function Sidebar() {
  const folders = useUi((s) => s.data?.folders ?? []);

  const createFolder = openNewFolderDialog;
  const spaceMenu = useTreeSpaceMenu();

  return (
    <aside className="flex w-[280px] shrink-0 flex-col border-r border-line bg-panel">
      <SidebarNav />
      <div className="flex h-10 items-center justify-between px-3 pl-4">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-faint">{t("folders")}</span>
        <IconButton icon={FolderPlus} label={t("newFolder")} onClick={() => createFolder(null)} />
      </div>
      <Slot name="sidebar.header" />
      <nav className="flex-1 overflow-y-auto px-2 pb-3" aria-label={t("folders")} onContextMenu={spaceMenu.open}>
        {folders.length === 0 ? (
          <div className="mx-2 mt-2 rounded-lg border border-dashed border-line p-4 text-center">
            <FolderOpen size={18} className="mx-auto text-faint" strokeWidth={1.75} />
            <div className="mt-2 font-medium">{t("noFoldersTitle")}</div>
            <div className="mt-1 text-xs text-muted">{t("noFoldersBody")}</div>
            <Button size="sm" icon={FolderPlus} className="mt-3" onClick={() => createFolder(null)}>
              {t("createFolder")}
            </Button>
          </div>
        ) : (
          <FolderList parentId={null} depth={0} createFolder={createFolder} />
        )}
      </nav>
      <TreeSpaceMenu at={spaceMenu.at} onClose={spaceMenu.close} />
      <PickedBar />
      <SidebarFooter />
    </aside>
  );
}

/** A right click on the tree's empty space opens plugins' items there (the "tree.menu" slot) at the pointer. */
function useTreeSpaceMenu() {
  const filled = useSlotFilled("tree.menu");
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  return {
    at,
    close: () => setAt(null),
    open: (e: React.MouseEvent) => {
      if (!filled || e.defaultPrevented || !onTreeSpace(e.target)) return;
      e.preventDefault();
      setAt({ x: e.clientX, y: e.clientY });
    },
  };
}

function TreeSpaceMenu({ at, onClose }: { at: { x: number; y: number } | null; onClose: () => void }) {
  return (
    <Menu open={!!at} onOpenChange={(open) => !open && onClose()}>
      <MenuTrigger asChild>
        <span aria-hidden className="pointer-events-none fixed size-0" style={{ left: at?.x ?? 0, top: at?.y ?? 0 }} />
      </MenuTrigger>
      <MenuContent>
        <Slot name="tree.menu" />
      </MenuContent>
    </Menu>
  );
}

interface TreeProps {
  createFolder: (parentId: string | null) => void;
}

function FolderList({ parentId, depth, ...tree }: { parentId: string | null; depth: number } & TreeProps) {
  const folders = useUi((s) => s.data?.folders ?? []);
  return (
    <ul role={depth === 0 ? "tree" : "group"}>
      {folders
        .filter((f) => f.parentId === parentId)
        .map((folder) => (
          <FolderNode key={folder.id} folder={folder} depth={depth} {...tree} />
        ))}
    </ul>
  );
}

function FolderNode({ folder, depth, ...tree }: { folder: Folder; depth: number } & TreeProps) {
  const collapsed = useUi((s) => !!s.collapsed[folder.id]);
  const renaming = useUi((s) => s.renaming === folder.id);
  // A process editor's trial runs stay out of the tree: the editor shows them.
  const tasks = useUi((s) => s.data?.tasks ?? []).filter((task) => task.folderId === folder.id && !task.meta?.trial);
  const selected = useUi((s) => s.selection?.kind === "folder" && s.selection.id === folder.id);
  const toggle = () => setState({ collapsed: { ...getState().collapsed, [folder.id]: !collapsed } });
  // The first click opens the folder's page and unfolds it; a click on the open folder folds it.
  const open = () => (selected ? toggle() : (selectFolder(folder.id), collapsed && toggle()));
  const [menu, setMenu] = useState(false);

  return (
    <li role="treeitem" aria-expanded={!collapsed}>
      <Row id={folder.id} depth={depth} selected={selected} onClick={open} onMenu={() => setMenu(true)}>
        <button
          tabIndex={-1}
          aria-label={collapsed ? t("expand") : t("collapse")}
          className="-m-1 grid shrink-0 place-items-center rounded p-1 hover:bg-hover"
          onClick={(e) => (e.stopPropagation(), toggle())}
        >
          <ChevronRight size={13} className={cx("text-faint transition-transform", !collapsed && "rotate-90")} />
        </button>
        <FolderIcon size={14} className="shrink-0 text-muted" strokeWidth={1.75} />
        <Name
          value={folder.name}
          editing={renaming}
          onDone={(name) => {
            setState({ renaming: null });
            if (name && name !== folder.name) void attempt(() => api.patch(`/api/folders/${folder.id}`, { name }));
          }}
          className="font-medium"
        />
        <Slot name="folder.badge" folder={folder} />
        <span className="ml-auto flex items-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          <FolderTaskButtons folder={folder} />
          <Menu open={menu} onOpenChange={setMenu}>
            <MenuTrigger asChild>
              <IconButton icon={MoreHorizontal} label={folder.name} onClick={(e) => e.stopPropagation()} />
            </MenuTrigger>
            <MenuContent>
              <FolderTaskMenuItems folder={folder} />
              <MenuItem icon={FolderPlus} onSelect={() => tree.createFolder(folder.id)}>
                {t("newSubfolder")}
              </MenuItem>
              <MenuItem icon={Pencil} shortcut={shortcutHint("rename", "folder")} onSelect={() => startRename(folder.id)}>
                {t("rename")}
              </MenuItem>
              <MenuItem icon={Repeat} onSelect={() => openAutomationDialog(folder)}>
                {t("newAutomationMenu")}
              </MenuItem>
              <MenuSeparator />
              <ArchiveDoneItem folder={folder} />
              <MenuItem icon={Archive} onSelect={() => openArchive(folder.id)}>
                {t("archive")}
              </MenuItem>
              <Slot name="folder.menu" folder={folder} />
              <MenuSeparator />
              <MenuItem
                icon={Trash2}
                danger
                shortcut={shortcutHint("delete", "folder")}
                onSelect={() => confirmDeleteFolder(folder)}
              >
                {t("delete")}
              </MenuItem>
            </MenuContent>
          </Menu>
        </span>
      </Row>
      {!collapsed && (
        <>
          <FolderList parentId={folder.id} depth={depth + 1} {...tree} />
          <FolderTasks folderId={folder.id} tasks={tasks} depth={depth + 1} />
        </>
      )}
    </li>
  );
}

function TaskNode({ task, depth }: { task: Task; depth: number }) {
  const selected = useUi((s) => s.selection?.kind === "task" && s.selection.id === task.id);
  const status = useUi((s) => s.data?.statuses.find((x) => x.id === task.status));
  const running = useUi((s) => s.data?.sessions.some((x) => x.taskId === task.id && x.state === "running"));
  const renaming = useUi((s) => s.renaming === task.id);
  const picked = useUi((s) => s.picked.includes(task.id));
  const archiveAt = useUi((s) => s.data?.archive.archiveAt[task.id]);
  const automation = task.meta.automation as { how: string } | undefined;
  const [menu, setMenu] = useState(false);

  return (
    <li role="treeitem" aria-selected={selected}>
      <Row
        id={task.id}
        task
        depth={depth}
        selected={selected}
        picked={picked}
        title={archiveAt ? t("willArchive", { when: formatIn(archiveAt) }) : undefined}
        onClick={(e) => (e && (e.ctrlKey || e.metaKey || e.shiftKey) ? pick(task.id, e.shiftKey) : selectTask(task.id))}
        onMenu={() => setMenu(true)}
      >
        <ProcessState task={task} />
        <span className="grid w-[14px] shrink-0 place-items-center">
          <StatusDot color={status?.color ?? "gray"} pulse={running} />
        </span>
        <Name
          value={task.title}
          editing={renaming}
          onDone={(title) => {
            setState({ renaming: null });
            if (title && title !== task.title) void attempt(() => api.patch(`/api/tasks/${task.id}`, { title }));
            selectTask(task.id);
          }}
        />
        <AgentAsks task={task} />
        {automation && (
          <span className="grid shrink-0 place-items-center text-faint" title={automation.how === "webhook" ? t("madeByWebhook") : t("madeBySchedule")}>
            {automation.how === "webhook" ? <Webhook size={11} /> : <Repeat size={11} />}
          </span>
        )}
        <Slot name="task.badge" task={task} />
        <span className="ml-auto flex items-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          <Menu open={menu} onOpenChange={setMenu}>
            <MenuTrigger asChild>
              <IconButton icon={MoreHorizontal} label={task.title} onClick={(e) => e.stopPropagation()} />
            </MenuTrigger>
            <MenuContent>
              <MenuItem icon={Pencil} shortcut={shortcutHint("rename", "task")} onSelect={() => startRename(task.id)}>
                {t("rename")}
              </MenuItem>
              <Slot name="task.menu" task={task} />
              <MenuSeparator />
              <MenuItem icon={Archive} shortcut={shortcutHint("archive", "task")} onSelect={() => archiveTasks([task])}>
                {t("toArchive")}
              </MenuItem>
              <MenuItem icon={Trash2} danger shortcut={shortcutHint("deleteForever", "task")} onSelect={() => confirmDeleteForever([task])}>
                {t("deleteForever")}
              </MenuItem>
            </MenuContent>
          </Menu>
        </span>
      </Row>
    </li>
  );
}

/** After the task's name while one of its agents shows the user a question, such as a permission prompt. */
function AgentAsks({ task }: { task: Task }) {
  const asking = useUi((s) => s.data?.sessions.some((x) => x.taskId === task.id && x.asking) ?? false);
  if (!asking) return null;
  return (
    <span className="grid shrink-0 place-items-center" title={t("agentAsks")} aria-label={t("agentAsks")} role="img">
      <Hand size={12} className="text-[var(--s-amber)]" />
    </span>
  );
}

/** Left of the task's name: a clock while its process works, a question while it waits for the user, an alert when it failed. */
function ProcessState({ task }: { task: Task }) {
  const run = useUi((s) => s.data?.processes.runs.find((r) => r.taskId === task.id));
  const step = useUi((s) => s.data?.processes.defs.find((w) => w.id === run?.process)?.nodes.find((n) => n.id === run?.node)?.label);
  const box = "grid w-[13px] shrink-0 place-items-center";
  if (!run || run.state === "done") return <span className={box} />;
  const [Icon, tone, label] =
    run.state === "running"
      ? [LoaderCircle, "animate-spin text-muted", run.progress ?? t("processRunning", { step: step ?? run.node ?? "" })]
      : run.state === "waiting"
        ? [MessageCircleQuestion, "text-accent", run.request?.title ?? t("processWaiting")]
        : [CircleAlert, "text-[var(--danger)]", run.error ?? t("processFailed", { step: step ?? "" })];
  return (
    <span className={box} title={label} aria-label={label} role="img">
      <Icon size={12} className={tone} />
    </span>
  );
}

/** The tree row that had the focus last, while nothing else took it. */
let focusedRow: string | null = null;

function Row({
  id,
  depth,
  selected,
  picked,
  task,
  title,
  onClick,
  onMenu,
  children,
}: {
  /** Folder or task id; keyboard shortcuts act on the row in focus. */
  id: string;
  depth: number;
  selected?: boolean;
  /** Picked with Ctrl or Shift, for actions on several tasks. */
  picked?: boolean;
  /** A task's row: picking with Shift takes the task rows between. */
  task?: boolean;
  title?: string;
  onClick: (e?: React.MouseEvent) => void;
  /** A right click opens the row's menu, the one behind its three dots. */
  onMenu?: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // A row that moved (its task changed status or folder) is drawn anew: the focus it had comes back to it.
  useEffect(() => {
    const active = document.activeElement;
    if (focusedRow === id && (!active || active === document.body)) ref.current?.focus();
  }, [id]);
  return (
    <div
      ref={ref}
      tabIndex={0}
      data-tree-id={id}
      onFocus={(e) => e.target === e.currentTarget && (focusedRow = id)}
      onBlur={(e) => e.target === e.currentTarget && e.relatedTarget && (focusedRow = null)}
      data-tree-task={task ? "" : undefined}
      title={title}
      onClick={onClick}
      onContextMenu={(e) => onMenu && rowContextMenu(e, onMenu)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        } else rowArrow(e);
      }}
      style={{ paddingLeft: 6 + depth * 14 }}
      className={cx(
        "group relative flex h-8 cursor-default select-none items-center gap-1.5 rounded-md pr-1 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/60",
        selected ? "bg-hover text-text" : "text-text/90 hover:bg-hover/60",
        picked && "bg-[color-mix(in_srgb,var(--accent)_16%,transparent)]",
      )}
    >
      {selected && <span className="absolute inset-y-1.5 left-0 w-[2px] rounded-full bg-accent" />}
      {children}
    </div>
  );
}

/** A name that turns into an input while renaming. */
function Name({
  value,
  editing,
  onDone,
  className,
}: {
  value: string;
  editing: boolean;
  onDone: (value: string) => void;
  className?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);
  if (!editing) return <span className={cx("min-w-0 truncate", className)}>{value}</span>;
  return (
    <input
      ref={input}
      defaultValue={value}
      onClick={(e) => e.stopPropagation()}
      onBlur={(e) => onDone(e.target.value.trim())}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key !== "Enter" && e.key !== "Escape") return;
        if (e.key === "Escape") e.currentTarget.value = value;
        // Keep the focus on the row, so the next shortcut acts on it too.
        const row = e.currentTarget.closest<HTMLElement>("[data-tree-id]");
        e.currentTarget.blur();
        row?.focus();
      }}
      className="h-6 min-w-0 flex-1 rounded border border-accent bg-bg px-1.5 text-[13px] outline-none"
    />
  );
}

// Picking several tasks

let anchor: string | null = null;

/** Ctrl+click picks or unpicks a task; Shift+click picks the task rows from the last picked one. */
function pick(id: string, range: boolean): void {
  const { picked } = getState();
  if (range && anchor) {
    const rows = [...document.querySelectorAll<HTMLElement>("[data-tree-task]")].map((el) => el.dataset.treeId!);
    const [a, b] = [rows.indexOf(anchor), rows.indexOf(id)].sort((x, y) => x - y);
    if (a >= 0) return setState({ picked: [...new Set([...picked, ...rows.slice(a, b + 1)])] });
  }
  anchor = id;
  setState({ picked: picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id] });
}

/** Under the tree while tasks are picked: what to do with all of them. */
function PickedBar() {
  const picked = useUi((s) => s.picked);
  const tasks = useUi((s) => s.data?.tasks ?? []).filter((x) => picked.includes(x.id));
  const folders = useUi((s) => s.data?.folders ?? []);
  if (tasks.length === 0) return null;
  return (
    <div className="mx-2 mb-2 flex items-center gap-1 rounded-lg border border-line bg-raised px-2 py-1.5 shadow-lg shadow-black/10">
      <span className="mr-auto text-xs font-medium">{t("pickedCount", { n: tasks.length })}</span>
      <IconButton icon={Archive} label={t("toArchive")} onClick={() => archiveTasks(tasks)} />
      <MoveMenu tasks={tasks} folders={folders} compact />
      <IconButton icon={X} label={t("clearPick")} onClick={() => setState({ picked: [] })} />
    </div>
  );
}

// A folder's tasks: open ones, automations' nodes, then the done ones folded

function FolderTasks({ folderId, tasks, depth }: { folderId: string; tasks: Task[]; depth: number }) {
  const statuses = useUi((s) => s.data?.statuses ?? []);
  const automations = useUi((s) => s.data?.automations ?? []).filter((a) => a.folderId === folderId);
  // Tasks that need the user show in the folder even when their automation hides its tasks.
  const attention = useUi((s) => (s.data ? [...needingUser(s.data)].sort().join(",") : ""));
  const doneOpen = useUi((s) => !!s.opened[`done:${folderId}`]);
  const done = new Set(statuses.filter((x) => x.category === "done").map((x) => x.id));
  const { open, groups, done: finished } = folderSections(tasks, done, automations, new Set(attention.split(",")));
  const toggle = () => setState({ opened: { ...getState().opened, [`done:${folderId}`]: !doneOpen } });
  return (
    <ul role="group">
      {open.map((task) => (
        <TaskNode key={task.id} task={task} depth={depth} />
      ))}
      {groups.map(({ automation: a, tasks }) => (
        <AutomationNode key={a.id} automation={a} tasks={tasks} depth={depth} />
      ))}
      {finished.length > 0 && (
        <li role="treeitem" aria-expanded={doneOpen}>
          <button
            onClick={toggle}
            style={{ paddingLeft: 6 + depth * 14 }}
            className="flex h-7 w-full items-center gap-1.5 rounded-md pr-1 text-xs text-faint transition-colors hover:bg-hover/60 hover:text-muted"
          >
            <ChevronRight size={12} className={cx("transition-transform", doneOpen && "rotate-90")} />
            {t("doneGroup")} <span className="tabular-nums">{finished.length}</span>
          </button>
          {doneOpen && (
            <ul role="group">
              {finished.map((task) => (
                <TaskNode key={task.id} task={task} depth={depth} />
              ))}
            </ul>
          )}
        </li>
      )}
    </ul>
  );
}

/** An automation in its folder: its tasks under it (when it shows them so), its menu, and its state. */
function AutomationNode({ automation: a, tasks, depth }: { automation: Automation; tasks: Task[]; depth: number }) {
  const opened = useUi((s) => !!s.opened[`automation:${a.id}`]);
  const selected = useUi((s) => s.selection?.kind === "automation" && s.selection.id === a.id);
  const toggle = () => setState({ opened: { ...getState().opened, [`automation:${a.id}`]: !opened } });
  const shown = a.view === "group" ? tasks : [];
  const [menu, setMenu] = useState(false);
  return (
    <li role="treeitem" aria-expanded={shown.length ? opened : undefined}>
      <Row
        id={`automation:${a.id}`}
        depth={depth}
        selected={selected}
        title={a.nextRun ? t("nextRunAt", { when: new Date(a.nextRun).toLocaleString() }) : undefined}
        onClick={() => selectAutomation(a.id)}
        onMenu={() => setMenu(true)}
      >
        <button
          tabIndex={-1}
          aria-label={opened ? t("collapse") : t("expand")}
          className={cx("-m-1 grid shrink-0 place-items-center rounded p-1 hover:bg-hover", !shown.length && "invisible")}
          onClick={(e) => (e.stopPropagation(), toggle())}
        >
          <ChevronRight size={12} className={cx("text-faint transition-transform", opened && "rotate-90")} />
        </button>
        <TriggerIcon automation={a} size={12} />
        <span className={cx("min-w-0 truncate", !a.enabled && "text-muted")}>{a.name}</span>
        {shown.length > 0 && <span className="shrink-0 text-[11px] tabular-nums text-faint">{shown.length}</span>}
        <span className="ml-auto flex items-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          <Menu open={menu} onOpenChange={setMenu}>
            <MenuTrigger asChild>
              <IconButton icon={MoreHorizontal} label={a.name} onClick={(e) => e.stopPropagation()} />
            </MenuTrigger>
            <MenuContent>
              <MenuItem icon={Play} onSelect={() => void runNow(a)}>
                {t("runNow")}
              </MenuItem>
              <MenuItem icon={a.enabled ? Pause : Play} onSelect={() => setPaused(a, a.enabled)}>
                {a.enabled ? t("pause") : t("resume")}
              </MenuItem>
              <MenuItem icon={Repeat} onSelect={() => selectAutomation(a.id)}>
                {t("open")}
              </MenuItem>
            </MenuContent>
          </Menu>
        </span>
      </Row>
      {opened && shown.length > 0 && (
        <ul role="group">
          {shown.map((task) => (
            <TaskNode key={task.id} task={task} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** "Archive done (N)" in a folder's menu, when it has done tasks. */
function ArchiveDoneItem({ folder }: { folder: Folder }) {
  const done = doneUnder(folder);
  if (done.length === 0) return null;
  return (
    <MenuItem icon={ArchiveRestore} onSelect={() => archiveTasks(done)}>
      {t("archiveDone", { n: done.length })}
    </MenuItem>
  );
}

/** At the top, above the folders' header: plugins' pages (Processes) and Automations, always there. */
function SidebarNav() {
  const failing = useUi((s) => s.data?.automations.some((a) => a.failing || a.rejecting) ?? false);
  const kind = useUi((s) => s.selection?.kind);
  return (
    <div className="border-b border-line px-2 py-2">
      <Slot name="sidebar.nav" />
      <button className={sidebarItem(kind === "automations" || kind === "automation")} onClick={openAutomations}>
        <Repeat size={14} strokeWidth={1.75} />
        {t("automations")}
        {failing && <span className="ml-auto size-1.5 rounded-full bg-danger" />}
      </button>
    </div>
  );
}

const sidebarItem = (active: boolean) =>
  cx(
    "flex h-8 w-full items-center gap-2 rounded-md px-2.5 text-[13px] transition-colors",
    active ? "bg-hover text-text" : "text-muted hover:bg-hover/60 hover:text-text",
  );

/** Under the tree: the archive. */
function SidebarFooter() {
  const archive = useUi((s) => s.data?.archive);
  const kind = useUi((s) => s.selection?.kind);
  return (
    <div className="border-t border-line px-2 py-2">
      <Slot name="sidebar.footer" />
      <button
        className={sidebarItem(kind === "archive" || kind === "archived")}
        onClick={() => openArchive()}
        title={archive?.dueSoon ? t("archiveDueSoon", { n: archive.dueSoon }) : undefined}
      >
        <Archive size={14} strokeWidth={1.75} />
        {t("archive")}
        {!!archive?.count && (
          <span className={cx("ml-auto text-[11px] tabular-nums", archive.dueSoon ? "text-[var(--s-amber)]" : "text-faint")}>{archive.count}</span>
        )}
      </button>
    </div>
  );
}
