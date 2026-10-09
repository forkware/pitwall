// The task's details panel, on the right of its terminal: what is not needed every minute.
// Description (the task's text, and what plugins add above it), Process (what the process did and will do),
// Environment (where the task works: what plugins add, and its agents).
import { CircleAlert, CircleCheck, CornerDownLeft, FileText, LoaderCircle, MessageCircleQuestion, Pencil, CircleStop, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { Session, Task, ProcessInfo, ProcessRun, ProcessTraceEntry } from "../../sdk/types.ts";
import { api, useUi, type DetailsTab } from "../api.ts";
import { formatTime, statusLabel } from "../format.ts";
import { t } from "../i18n.ts";
import { attempt, Button, cx, IconButton, StatusDot } from "../kit/index.tsx";
import { Markdown } from "../markdown.tsx";
import { duration, endedBadly, historyItems, nextNodes, outputTexts, waitsForAgent, type HistoryItem } from "../processHistory.ts";
import { Slot } from "../slots.tsx";
import { closeDetails, openDetails, showOutput } from "../taskDetails.ts";
import { TextArea } from "../TextArea.tsx";
import { optionText, outcomeText, stepText, processText } from "../processText.ts";
import { useLastRun } from "./ProcessBar.tsx";

export const units = () => ({ h: t("unit.h"), m: t("unit.m"), s: t("unit.s") });

export function TaskDetails({
  task,
  tab,
  sessions,
  onShowSession,
  startAgent,
}: {
  task: Task;
  tab: DetailsTab;
  sessions: Session[];
  onShowSession: (id: string) => void;
  startAgent: React.ReactNode;
}) {
  const last = useLastRun(task);
  const tabs: DetailsTab[] = last ? ["description", "process", "environment"] : ["description", "environment"];
  const shown = tabs.includes(tab) ? tab : "description";
  return (
    <aside
      aria-label={t("details")}
      className="absolute inset-y-0 right-0 z-20 flex w-[400px] max-w-full shrink-0 flex-col border-l border-line bg-panel shadow-xl @[64rem]/task:static @[64rem]/task:shadow-none"
    >
      <div role="tablist" className="flex h-10 shrink-0 items-end gap-1 border-b border-line pl-3 pr-2">
        {tabs.map((id) => (
          <button
            key={id}
            role="tab"
            aria-selected={id === shown}
            onClick={() => openDetails(id)}
            className={cx(
              "h-9 px-2.5 text-[12.5px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/60",
              id === shown ? "font-semibold text-text shadow-[inset_0_-2px_var(--accent)]" : "text-muted hover:text-text",
            )}
          >
            {t(`details.${id}`)}
          </button>
        ))}
        <IconButton icon={X} label={t("close")} className="mb-1.5 ml-auto size-7" onClick={closeDetails} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3.5">
        {shown === "description" && <DescriptionTab task={task} />}
        {shown === "process" && last && <ProcessTab task={task} run={last.run} def={last.def} agentWorks={waitsForAgent(last.run, sessions)} />}
        {shown === "environment" && (
          <EnvironmentTab task={task} sessions={sessions} onShowSession={onShowSession} startAgent={startAgent} />
        )}
      </div>
    </aside>
  );
}

function SectionTitle({ children, actions }: { children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="mb-2 mt-5 flex items-center gap-2 first:mt-0">
      <span className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted">{children}</span>
      <span className="ml-auto flex items-center">{actions}</span>
    </div>
  );
}

// ---- Description ----

function DescriptionTab({ task }: { task: Task }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(task.body);
  useEffect(() => setText(task.body), [task.body]);
  const save = async () => {
    const done = await attempt(() => api.patch(`/api/tasks/${task.id}`, { body: text }));
    if (done !== undefined) setEditing(false);
  };
  return (
    <div>
      <div className="empty:hidden">
        <Slot name="task.details.description" task={task} />
      </div>
      <SectionTitle
        actions={
          !editing && (
            <Button size="sm" variant="ghost" icon={Pencil} onClick={() => setEditing(true)}>
              {t("edit")}
            </Button>
          )
        }
      >
        {t("taskText")}
      </SectionTitle>
      {editing ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void save();
            }
            if (e.key === "Escape") {
              e.stopPropagation();
              setText(task.body);
              setEditing(false);
            }
          }}
        >
          <TextArea
            autoFocus
            rows={8}
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="w-full resize-y rounded-md border border-line bg-bg px-2.5 py-1.5 text-[13px] outline-none focus:border-accent"
          />
          <div className="mt-2 flex justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setText(task.body);
                setEditing(false);
              }}
            >
              {t("cancel")}
            </Button>
            <Button size="sm" variant="primary" type="submit">
              {t("save")}
            </Button>
          </div>
        </form>
      ) : task.body.trim() ? (
        <Markdown source={task.body} className="text-muted" />
      ) : (
        <div className="flex items-center gap-2 text-[13px] text-faint">
          <FileText size={14} />
          {t("noBody")}
          <button className="text-accent hover:underline" onClick={() => setEditing(true)}>
            {t("writeBody")}
          </button>
        </div>
      )}
    </div>
  );
}

// ---- Process ----

/** The steps the task's process ran, kept fresh while its run changes. */
function useTrace(taskId: string, stamp: number): ProcessTraceEntry[] {
  const [trace, setTrace] = useState<ProcessTraceEntry[]>([]);
  useEffect(() => {
    let alive = true;
    void api
      .get<ProcessTraceEntry[]>(`/api/tasks/${taskId}/process/trace`)
      .then((x) => alive && setTrace(x))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [taskId, stamp]);
  return trace;
}

/** Re-renders now and then, for times that grow ("going 12 min"). */
export function useTicker(ms = 30_000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

function ProcessTab({ task, run, def, agentWorks }: { task: Task; run: ProcessRun; def?: ProcessInfo; agentWorks: boolean }) {
  const trace = useTrace(task.id, run.updatedAt);
  const now = useTicker();
  const statuses = useUi((s) => s.data?.statuses ?? []);
  const steps = useUi((s) => s.data?.processes.steps ?? []);
  const [open, setOpen] = useState<number | null>(null);
  const items = historyItems(trace, def);
  const name = def ? processText(def) : run.process;
  const ended = run.state === "done";
  const summary = [
    name,
    ended ? t("processTook", { time: duration(run.updatedAt - run.startedAt, units()) }) : t("processGoing", { time: duration(now - run.startedAt, units()) }),
    run.state === "waiting" ? t("processWaits", { time: duration(now - run.updatedAt, units()) }) : "",
  ].filter(Boolean);
  const nodeName = (id: string) => {
    const node = def?.nodes.find((n) => n.id === id);
    const step = steps.find((s) => s.id === node?.step);
    return node ? (step && node.label === step.label ? stepText(step) : node.label) : id;
  };
  const next = ended ? [] : nextNodes(def?.spec, run.path[0] ?? run.node).map(nodeName);
  return (
    <div>
      <div className="mb-2 text-xs text-muted">{summary.join(" · ")}</div>
      {items.length === 0 && <p className="text-[13px] text-faint">{t("historyEmpty")}</p>}
      <ol>
        {items.map((item) => (
          <li key={item.entry.seq}>
            {item.stage && (
              <div className="flex items-center gap-1.5 pb-0.5 pl-[30px] pt-2 text-[11px] text-faint">
                <StatusDot color={statuses.find((s) => s.id === item.stage)?.color ?? "gray"} />
                {statusLabel(statuses.find((s) => s.id === item.stage), item.stage ?? "")}
              </div>
            )}
            <HistoryRow
              task={task}
              item={item}
              name={nodeName(item.node)}
              open={open === item.entry.seq}
              current={!ended && item === items.at(-1) && (item.entry.result === "running" || item.entry.result === "asked")}
              agentWorks={agentWorks && item === items.at(-1)}
              onToggle={() => setOpen(open === item.entry.seq ? null : item.entry.seq)}
            />
          </li>
        ))}
      </ol>
      {next.length > 0 && <div className="pl-[30px] pt-2.5 text-xs text-faint">{t("nextSteps", { steps: next.join(" → ") })}</div>}
      <div className="mt-4 flex flex-wrap gap-1 pl-[22px] empty:hidden">
        <Slot name="task.details.process" task={task} run={run} />
      </div>
    </div>
  );
}

function HistoryRow({
  task,
  item,
  name,
  open,
  current,
  agentWorks,
  onToggle,
}: {
  task: Task;
  item: HistoryItem;
  name: string;
  open: boolean;
  current: boolean;
  /** The step waits for the task's agent, not for the user: it is running as far as the user is concerned. */
  agentWorks: boolean;
  onToggle: () => void;
}) {
  const steps = useUi((s) => s.data?.processes.steps ?? []);
  const entry = agentWorks && item.entry.result === "asked" ? { ...item.entry, result: "running" as const } : item.entry;
  const step = steps.find((s) => s.id === entry.step);
  const outcomes = Object.entries(entry.output ?? {})
    .filter(([key]) => step?.outcomes[key])
    .map(([key, value]) => {
      const v = typeof value === "string" ? value : JSON.stringify(value);
      return outcomeText(key, v, step!.outcomes[key][v] ?? v);
    });
  const answer =
    entry.result === "answered" && typeof entry.answer === "string"
      ? t("history.answered", { answer: optionText(entry.step, { id: entry.answer, label: entry.answer }) })
      : "";
  const result =
    entry.result === "failed"
      ? t("history.failed")
      : entry.result === "asked"
        ? t("history.asked")
        : entry.result === "running"
          ? t("history.running")
          : answer || outcomes.join(", ");
  const took = entry.endedAt && entry.endedAt - entry.startedAt > 5000 ? duration(entry.endedAt - entry.startedAt, units()) : "";
  const texts = [...(entry.error ? [{ key: "error", text: entry.error }] : []), ...outputTexts(entry.output)];
  const bad = entry.result === "done" && endedBadly(entry.output, step?.outcomes);
  const Icon =
    entry.result === "failed" || bad
      ? CircleAlert
      : entry.result === "asked"
        ? MessageCircleQuestion
        : entry.result === "running"
          ? LoaderCircle
          : CircleCheck;
  const time = formatTime(entry.startedAt);
  const detail = texts.length > 0 || (entry.answer !== null && typeof entry.answer === "object");
  return (
    <div className={cx("rounded-md", current && "bg-[color-mix(in_srgb,var(--accent)_7%,transparent)] shadow-[inset_2px_0_var(--accent)]", open && "bg-raised")}>
      <button
        aria-expanded={detail ? open : undefined}
        onClick={detail ? onToggle : undefined}
        className={cx(
          "grid w-full grid-cols-[16px_1fr_auto] items-start gap-x-2.5 px-2 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
          detail ? "cursor-pointer" : "cursor-default",
        )}
      >
        <Icon
          size={15}
          className={cx(
            "mt-0.5",
            entry.result === "failed"
              ? "text-[var(--danger)]"
              : bad
                ? "text-[var(--s-amber)]"
                : entry.result === "asked"
                  ? "text-accent"
                  : entry.result === "running"
                    ? "animate-spin text-faint"
                    : "text-[var(--s-green)]",
          )}
        />
        <span className="min-w-0">
          <span className="font-medium">{name}</span>
          {result && <span className={cx(entry.result === "failed" ? "text-[var(--danger)]" : "text-muted")}> — {result}</span>}
          {(item.back || took) && (
            <span className="mt-0.5 flex items-center gap-1 text-[11.5px] text-faint">
              {item.back && <CornerDownLeft size={11} className="text-[var(--s-amber)]" />}
              {[item.back ? t("history.back") : "", took].filter(Boolean).join(" · ")}
            </span>
          )}
        </span>
        <span className="pt-0.5 text-[11px] tabular-nums text-faint">{time}</span>
      </button>
      {open && (
        <div className="space-y-2 px-2 pb-2.5 pl-[34px]">
          {entry.answer !== null && typeof entry.answer === "object" && (
            <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 text-xs">
              {Object.entries(entry.answer as Record<string, unknown>).map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-faint">{k}</dt>
                  <dd className="min-w-0 select-text break-words text-muted">{Array.isArray(v) ? v.join(", ") : String(v ?? "")}</dd>
                </div>
              ))}
            </dl>
          )}
          {texts.map(({ key, text }) => (
            <div key={key} className="rounded-md border border-line bg-panel p-2">
              <pre className="line-clamp-4 select-text whitespace-pre-wrap break-words font-mono text-[11px] text-muted">{text}</pre>
              <Button size="sm" variant="secondary" className="mt-2" onClick={() => showOutput(task.id, t("outputOf", { step: name, time }), text)}>
                {t("showOutput")}
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Environment ----

function EnvironmentTab({
  task,
  sessions,
  onShowSession,
  startAgent,
}: {
  task: Task;
  sessions: Session[];
  onShowSession: (id: string) => void;
  startAgent: React.ReactNode;
}) {
  const providers = useUi((s) => s.data?.providers ?? []);
  return (
    <div>
      <div className="empty:hidden">
        <Slot name="task.details.environment" task={task} />
      </div>
      <SectionTitle>{t("agents")}</SectionTitle>
      <ul className="space-y-0.5">
        {sessions.map((s, i) => {
          const running = s.state === "running";
          return (
            <li key={s.id} className="group grid grid-cols-[10px_1fr_auto] items-center gap-x-2.5 rounded-md px-2 py-1.5 hover:bg-hover">
              <span
                className={cx("size-2 rounded-full", s.asking ? "bg-[var(--s-amber)]" : running ? "animate-pulse-dot bg-[var(--s-green)]" : "bg-faint")}
              />
              <span className="min-w-0">
                <button className="font-medium hover:underline" onClick={() => onShowSession(s.id)}>
                  {providers.find((p) => p.id === s.provider)?.label ?? s.provider} <span className="text-faint">#{i + 1}</span>
                </button>
                <span className="block truncate font-mono text-[11px] text-faint" title={s.cwd}>
                  {s.cwd}
                </span>
              </span>
              <span className="flex items-center gap-1 text-[11px] text-faint">
                {s.asking ? t("agentAsks") : running ? t("sessionRunning") : s.exitCode !== null ? t("exited", { code: s.exitCode }) : t("sessionExited")}
                {running ? (
                  <IconButton icon={CircleStop} label={t("stop")} className="size-6" onClick={() => void attempt(() => api.post(`/api/sessions/${s.id}/kill`))} />
                ) : (
                  <IconButton icon={X} label={t("close")} className="size-6" onClick={() => void attempt(() => api.del(`/api/sessions/${s.id}`))} />
                )}
              </span>
            </li>
          );
        })}
      </ul>
      <div className="mt-2">{startAgent}</div>
    </div>
  );
}
