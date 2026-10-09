import {
  Archive,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  History,
  LoaderCircle,
  MessageCircleQuestion,
  MoreHorizontal,
  PanelRight,
  Pencil,
  Play,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { archiveTasks, confirmDeleteForever } from "../archiveActions.ts";
import { shortcutHint } from "../shortcuts.ts";
import { AutomationOrigin } from "./AutomationOrigin.tsx";
import { useEffect, useState } from "react";
import type { Session, StatusCategory, Task, ProcessInfo, ProcessRun } from "../../sdk/types.ts";
import { api, useUi } from "../api.ts";
import { startRename } from "../sdk.tsx";
import { statusLabel } from "../format.ts";
import { t } from "../i18n.ts";
import { attempt, Button, cx, EmptyState, IconButton, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, StatusDot } from "../kit/index.tsx";
import { duration, waitsForAgent } from "../processHistory.ts";
import { Slot } from "../slots.tsx";
import { escapeDetails, hideOutput, openDetails, toggleDetails } from "../taskDetails.ts";
import { processText } from "../processText.ts";
import { TaskDetails, units, useTicker } from "./TaskDetails.tsx";
import { Terminal } from "./Terminal.tsx";
import { useAgentAnswer, useLastRun, useWhereText, useProcess, ProcessActions, ProcessCard } from "./ProcessBar.tsx";

export function TaskView({ task }: { task: Task }) {
  const folder = useUi((s) => s.data?.folders.find((f) => f.id === task.folderId));
  const sessions = useUi((s) => s.data?.sessions.filter((x) => x.taskId === task.id) ?? []);
  const details = useUi((s) => s.details);
  const output = useUi((s) => (s.output?.taskId === task.id ? s.output : null));
  const [activeId, setActiveId] = useState<string | null>(null);
  const active = sessions.find((s) => s.id === activeId) ?? sessions.at(-1);
  const done = useUi((s) => s.data?.statuses.find((x) => x.id === task.status)?.category === "done");
  const process = useProcess(task);
  const asksUser = useAsksUser(task);
  const failed = process?.run.state === "failed";

  // A session that just started becomes the active tab.
  const newest = sessions.at(-1)?.id;
  useEffect(() => setActiveId(newest ?? null), [newest]);

  // Another task's output is not this one's.
  useEffect(() => hideOutput, [task.id]);

  // Esc outside the terminal and the fields takes the shown output away, then closes the details.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const focused = document.activeElement;
      if (focused?.closest("input, textarea, select, [contenteditable='true'], .xterm, [role='dialog'], [role='menu']")) return;
      if (escapeDetails()) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const start = async (provider?: string) => {
    const session = await attempt(() => api.post<Session>(`/api/tasks/${task.id}/sessions`, { provider }));
    if (session) setActiveId(session.id);
  };
  const showSession = (id: string) => {
    hideOutput();
    setActiveId(id);
  };

  return (
    <section className="@container/task flex h-full min-w-0 flex-col">
      <header
        className={cx(
          "@container flex min-h-16 shrink-0 items-center gap-3 border-b border-line py-2.5 pl-5 pr-3",
          failed
            ? "bg-[color-mix(in_srgb,var(--danger)_6%,var(--panel))]"
            : asksUser
              ? "bg-[color-mix(in_srgb,var(--accent)_6%,var(--panel))]"
              : "bg-panel",
        )}
      >
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5 text-xs text-faint">
            {folder && <span className="shrink-0 truncate">{folder.name}</span>}
            {folder && <span className="shrink-0">/</span>}
            <Where task={task} />
          </div>
          <h1 className="mt-0.5 truncate text-[15px] font-semibold leading-tight" title={task.title}>
            {task.title}
          </h1>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Slot name="task.header" task={task} />
          {process && <ProcessActions task={task} run={process.run} def={process.def} />}
          {done && (
            <Button size="sm" icon={Archive} onClick={() => archiveTasks([task])}>
              {t("archiveTask")}
            </Button>
          )}
          {/* Gone when nothing stands before it. */}
          <span className="mx-1 h-5 w-px bg-line first:hidden" />
          <IconButton
            icon={PanelRight}
            label={`${t("details")} (${shortcutHint("details.description", "task") ?? ""})`}
            aria-pressed={!!details}
            className={cx("size-8", details && "bg-raised text-text")}
            onClick={() => toggleDetails()}
          />
          <TaskMenu task={task} onStart={start} />
        </div>
      </header>
      <AutomationOrigin task={task} />
      <ProcessCard task={task} />
      <Slot name="task.panel" task={task} />

      <div className="relative flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {sessions.length > 1 && !output && (
            <div role="tablist" className="flex h-9 shrink-0 items-end gap-1 overflow-x-auto border-b border-line px-3">
              {sessions.map((s, i) => (
                <SessionTab key={s.id} session={s} index={i + 1} active={s.id === active?.id} onSelect={() => setActiveId(s.id)} />
              ))}
            </div>
          )}
          {active && !output && (
            <div className="flex shrink-0 items-center justify-end gap-1 border-b border-line bg-panel/60 px-4 py-1 empty:hidden">
              <Slot name="session.toolbar" task={task} session={active} />
            </div>
          )}
          {active?.state === "exited" && !output && <Slot name="session.ended" task={task} session={active} />}
          {output && (
            <div className="flex shrink-0 items-center gap-2.5 border-b border-line bg-[color-mix(in_srgb,var(--s-amber)_12%,var(--panel))] px-5 py-1.5 text-[12.5px]">
              <History size={14} className="text-[var(--s-amber)]" />
              <span className="min-w-0 truncate font-semibold">{output.title}</span>
              <span className="shrink-0 text-muted">· {t("readOnly")}</span>
              <Button size="sm" className="ml-auto" onClick={hideOutput}>
                {t("backToTerminal")}
                <span className="font-mono text-[10.5px] text-faint">Esc</span>
              </Button>
            </div>
          )}
          <div className="relative min-h-0 flex-1">
            {output && (
              <pre className="absolute inset-0 z-10 select-text overflow-auto whitespace-pre-wrap break-words bg-bg px-5 py-3.5 font-mono text-[13px] leading-relaxed">
                {output.text}
              </pre>
            )}
            {sessions.length === 0 ? (
              process ? (
                <div className="grid h-full place-items-center text-[13px] text-faint">
                  {process.run.state === "waiting" && process.run.request?.kind === "form" ? t("agentAfterAnswer") : t("agentByProcess")}
                </div>
              ) : (
                <EmptyState icon={Bot} title={t("noSessionsTitle")} body={t("noSessionsBody")}>
                  <StartAgent onStart={start} />
                </EmptyState>
              )
            ) : (
              sessions.map((s) => <Terminal key={s.id} sessionId={s.id} visible={s.id === active?.id} />)
            )}
          </div>
        </div>
        {details && (
          <TaskDetails
            task={task}
            tab={details}
            sessions={sessions}
            onShowSession={showSession}
            startAgent={<StartAgent onStart={start} compact />}
          />
        )}
      </div>
    </section>
  );
}

/** The process waits for the user (a question or a form), not for an agent. */
function useAsksUser(task: Task): boolean {
  const process = useProcess(task);
  const sessions = useUi((s) => s.data?.sessions.filter((x) => x.taskId === task.id) ?? []);
  return !!process && process.run.state === "waiting" && !!process.run.request && !waitsForAgent(process.run, sessions);
}

/**
 * The line over the task's name: its status and where its process is. Clicking it opens the process;
 * without a process, the status is a menu that changes it.
 */
function Where({ task }: { task: Task }) {
  const last = useLastRun(task);
  const sessions = useUi((s) => s.data?.sessions.filter((x) => x.taskId === task.id) ?? []);
  if (!last) return <StatusPicker task={task} />;
  const { run, def } = last;
  if (run.state === "done")
    return (
      <>
        <StatusPicker task={task} />
        <span>·</span>
        <button
          className="min-w-0 truncate rounded px-1 text-muted hover:bg-hover hover:text-text"
          onClick={() => openDetails("process")}
        >
          {t("processFinished", { process: def ? processText(def) : run.process })}
        </button>
      </>
    );
  return <WhereRunning task={task} run={run} def={def} agentWorks={waitsForAgent(run, sessions)} />;
}

function WhereRunning({ task, run, def, agentWorks }: { task: Task; run: ProcessRun; def?: ProcessInfo; agentWorks: boolean }) {
  const statuses = useUi((s) => s.data?.statuses ?? []);
  const current = statuses.find((s) => s.id === task.status);
  const where = useWhereText(task, run, def);
  const now = useTicker();
  const text = agentWorks ? `${t("agentWorking")} · ${duration(now - run.updatedAt, units())}` : where.text;
  const Icon =
    run.state === "failed" ? CircleAlert : run.state === "waiting" && !agentWorks ? MessageCircleQuestion : LoaderCircle;
  return (
    <button
      title={`${where.title} — ${t("cmd.detailsProcess")} (${shortcutHint("details.process", "task") ?? ""})`}
      onClick={() => openDetails("process")}
      className="-ml-1 inline-flex min-w-0 items-center gap-1.5 rounded px-1 py-px outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent/60"
    >
      <StatusDot color={current?.color ?? "gray"} />
      <span className="shrink-0 text-muted">{current ? statusLabel(current) : task.status}</span>
      <span>·</span>
      <Icon
        size={12}
        className={cx(
          "shrink-0",
          run.state === "failed" ? "text-[var(--danger)]" : Icon === MessageCircleQuestion ? "text-accent" : "animate-spin text-faint",
        )}
      />
      <span
        className={cx(
          "min-w-0 truncate font-medium",
          run.state === "failed" ? "text-[var(--danger)]" : Icon === MessageCircleQuestion ? "text-accent" : "text-text",
        )}
      >
        {text}
      </span>
      <ChevronRight size={11} className="shrink-0" />
    </button>
  );
}

/** The task's one menu: what its process offers besides the header's answers, then the task's own actions. */
function TaskMenu({ task, onStart }: { task: Task; onStart: (provider?: string) => void }) {
  const agentAnswer = useAgentAnswer(task);
  const providers = useUi((s) => s.data?.providers.filter((p) => p.available) ?? []);
  return (
    <Menu>
      <MenuTrigger asChild>
        <IconButton icon={MoreHorizontal} label={t("moreActions")} className="size-8" />
      </MenuTrigger>
      <MenuContent align="end">
        {agentAnswer && (
          <>
            <div className="px-2.5 pb-0.5 pt-1 text-[11px] text-faint">{t("menuProcess")}</div>
            <MenuItem icon={Check} onSelect={agentAnswer.run}>
              {agentAnswer.label}
            </MenuItem>
            <MenuSeparator />
            <div className="px-2.5 pb-0.5 pt-1 text-[11px] text-faint">{t("menuTask")}</div>
          </>
        )}
        {providers.map((p) => (
          <MenuItem key={p.id} icon={Plus} onSelect={() => onStart(p.id)}>
            {providers.length > 1 ? `${t("newAgent")}: ${p.label}` : t("newAgent")}
          </MenuItem>
        ))}
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
  );
}

const categoryOrder: StatusCategory[] = ["open", "active", "done"];

/** The status as a small menu, for a task no process moves (a running process moves it by its answers). */
function StatusPicker({ task }: { task: Task }) {
  const statuses = useUi((s) => s.data?.statuses ?? []);
  const process = useProcess(task);
  const current = statuses.find((s) => s.id === task.status);
  const label = current ? statusLabel(current) : task.status;
  if (process)
    return (
      <span className="inline-flex shrink-0 items-center gap-1.5 text-muted">
        <StatusDot color={current?.color ?? "gray"} />
        {label}
      </span>
    );
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          aria-label={t("status")}
          className="-ml-1 inline-flex shrink-0 items-center gap-1.5 rounded px-1 py-px text-muted outline-none hover:bg-hover hover:text-text focus-visible:ring-2 focus-visible:ring-accent/60"
        >
          <StatusDot color={current?.color ?? "gray"} />
          {label}
          <ChevronDown size={11} className="text-faint" />
        </button>
      </MenuTrigger>
      <MenuContent>
        {categoryOrder.map((category, i) => {
          const group = statuses.filter((s) => s.category === category);
          if (group.length === 0) return null;
          return (
            <div key={category}>
              {i > 0 && <MenuSeparator />}
              {group.map((s) => (
                <MenuItem key={s.id} onSelect={() => void attempt(() => api.patch(`/api/tasks/${task.id}`, { status: s.id }))}>
                  <StatusDot color={s.color} />
                  <span className={cx(s.id === task.status && "font-semibold")}>{statusLabel(s)}</span>
                </MenuItem>
              ))}
            </div>
          );
        })}
      </MenuContent>
    </Menu>
  );
}

function StartAgent({ onStart, compact }: { onStart: (provider?: string) => void; compact?: boolean }) {
  const providers = useUi((s) => s.data?.providers ?? []);
  const available = providers.filter((p) => p.available);
  const [main] = available;

  if (providers.length === 0) return <span className="text-xs text-muted">{t("noProviders")}</span>;
  if (!main) return <span className="text-xs text-muted">{t("notInstalled", { agent: providers[0].label })}</span>;

  const label = compact ? t("newAgent") : t("startAgent", { agent: main.label });
  if (available.length === 1)
    return (
      <Button size={compact ? "sm" : undefined} variant={compact ? "ghost" : "primary"} icon={compact ? Plus : Play} onClick={() => onStart(main.id)}>
        {label}
      </Button>
    );
  return (
    <Menu>
      <MenuTrigger asChild>
        <Button size={compact ? "sm" : undefined} variant={compact ? "ghost" : "primary"} icon={compact ? Plus : Play}>
          {compact ? t("newAgent") : t("startAgent", { agent: "" }).trim()}
          <ChevronDown size={12} />
        </Button>
      </MenuTrigger>
      <MenuContent align="end">
        {available.map((p) => (
          <MenuItem key={p.id} icon={Bot} onSelect={() => onStart(p.id)}>
            {p.label}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}

function SessionTab({
  session,
  index,
  active,
  onSelect,
}: {
  session: Session;
  index: number;
  active: boolean;
  onSelect: () => void;
}) {
  const provider = useUi((s) => s.data?.providers.find((p) => p.id === session.provider));
  const running = session.state === "running";
  return (
    <div
      role="tab"
      aria-selected={active}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => e.key === "Enter" && onSelect()}
      className={cx(
        "group relative flex h-8 cursor-default select-none items-center gap-2 rounded-t-md pl-3 pr-1.5 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/60",
        active ? "bg-bg text-text" : "text-muted hover:text-text",
      )}
    >
      {active && <span className="absolute inset-x-2 top-0 h-[2px] rounded-full bg-accent" />}
      <span
        className={cx(
          "size-1.5 rounded-full",
          session.asking ? "bg-[var(--s-amber)]" : running ? "animate-pulse-dot bg-[var(--s-green)]" : "bg-faint",
        )}
        title={session.asking ? t("agentAsks") : undefined}
        aria-label={session.asking ? t("agentAsks") : undefined}
      />
      <span className="font-medium">
        {provider?.label ?? session.provider} <span className="text-faint">#{index}</span>
      </span>
      <IconButton
        icon={X}
        label={t("close")}
        className="size-5 opacity-0 group-hover:opacity-100"
        onClick={(e) => {
          e.stopPropagation();
          void attempt(() => api.del(`/api/sessions/${session.id}`));
        }}
      />
    </div>
  );
}
