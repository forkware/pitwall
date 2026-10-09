// Automations: tasks made by a schedule or a webhook. Their list, the page of one with its runs, and the editor.
import { CircleAlert, Copy, KeyRound, Pencil, Play, Plus, Repeat, Trash2, Webhook, Workflow } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Automation, AutomationConfig, AutomationRunView, AutomationTrigger, Folder } from "../../sdk/types.ts";
import { api, onEvent, useUi } from "../api.ts";
import { formatDateTime, formatWhen, statusLabel } from "../format.ts";
import { t } from "../i18n.ts";
import { attempt, Button, cx, Dialog, EmptyState, IconButton, Input, showCustomDialog, StatusDot, toast } from "../kit/index.tsx";
import { openTask, selectAutomation, selectFolder } from "../sdk.tsx";
import { folderProcesses } from "../folderProcesses.ts";
import { fillsFirstForm, newQuestions, processQuestions, QuestionAnswers, summary } from "./AutomationProcess.tsx";
import { fieldText, questionText, processText } from "../processText.ts";

// The list

/** Automations of a folder (with `folderId`), or all of them. */
export function AutomationList({ folderId }: { folderId?: string }) {
  const all = useUi((s) => s.data?.automations ?? []);
  const folders = useUi((s) => s.data?.folders ?? []);
  const list = folderId ? all.filter((a) => a.folderId === folderId) : all;
  const folder = folders.find((f) => f.id === folderId);
  const add = folder ? <Button size="sm" variant="primary" icon={Plus} onClick={() => openAutomationDialog(folder)}>{t("newAutomation")}</Button> : null;
  if (list.length === 0)
    return (
      <EmptyState icon={Repeat} title={t("automationsEmptyTitle")} body={t("automationsEmptyBody")}>
        {add}
      </EmptyState>
    );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {add && <div className="pb-3">{add}</div>}
      <div className="overflow-y-auto rounded-lg border border-line bg-panel">
        <table className="w-full table-fixed border-collapse text-[13px]">
          <thead className="text-[11px] text-faint">
            <tr className="border-b border-line">
              <th className="px-3 py-1.5 text-left font-medium">{t("name")}</th>
              {!folderId && <th className="w-[20%] px-2 py-1.5 text-left font-medium">{t("colFolder")}</th>}
              <th className="w-[24%] px-2 py-1.5 text-left font-medium">{t("colTrigger")}</th>
              <th className="w-[14%] px-2 py-1.5 text-left font-medium">{t("colNext")}</th>
              <th className="w-[18%] px-2 py-1.5 text-left font-medium">{t("colLast")}</th>
            </tr>
          </thead>
          <tbody>
            {list.map((a) => (
              <tr key={a.id} className="cursor-default border-b border-line/60 last:border-0 hover:bg-hover/50" onClick={() => selectAutomation(a.id)}>
                <td className="px-3 py-2">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <TriggerIcon automation={a} />
                    <span className={cx("truncate font-medium", !a.enabled && "text-muted")}>{a.name}</span>
                    {!a.enabled && <span className="shrink-0 text-[11px] text-faint">{t("paused")}</span>}
                  </div>
                </td>
                {!folderId && <td className="truncate px-2 py-2 text-xs text-muted">{folders.find((f) => f.id === a.folderId)?.name}</td>}
                <td className="truncate px-2 py-2 text-xs text-muted">{describeTrigger(a.trigger)}</td>
                <td className="px-2 py-2 text-xs text-muted">{a.nextRun ? formatWhen(a.nextRun) : "—"}</td>
                <td className="px-2 py-2 text-xs">{a.lastRun ? <RunResult automation={a} run={a.lastRun} short /> : <span className="text-faint">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function TriggerIcon({ automation, size = 13 }: { automation: Automation; size?: number }) {
  const Icon = automation.trigger.kind === "webhook" ? Webhook : Repeat;
  return (
    <span className="relative inline-grid shrink-0 place-items-center">
      <Icon size={size} className={automation.enabled ? "text-muted" : "text-faint"} />
      {(automation.failing || automation.rejecting) && <span className="absolute -right-1 -top-1 size-1.5 rounded-full bg-danger" />}
    </span>
  );
}

export function AutomationsPage() {
  return (
    <Page icon={<Repeat size={16} className="text-muted" strokeWidth={1.75} />} title={t("automations")}>
      <AutomationList />
    </Page>
  );
}

function Page({ icon, title, subtitle, actions, children }: { icon: ReactNode; title: string; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex h-full min-w-0 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-5">
        {icon}
        <div className="min-w-0">
          {subtitle && <div className="truncate text-[11px] text-faint">{subtitle}</div>}
          <h1 className="truncate text-[15px] font-semibold leading-tight">{title}</h1>
        </div>
        {actions && <div className="ml-auto flex items-center gap-1.5">{actions}</div>}
      </header>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 py-5">{children}</div>
    </section>
  );
}

// One automation

const pad = (n: number) => String(n).padStart(2, "0");

/** "Every day at 03:00", "On weekdays at 09:30", a custom expression as it is, "Webhook". */
export function describeTrigger(trigger: AutomationTrigger): string {
  if (trigger.kind === "webhook") return t("triggerWebhook");
  const s = fromCron(trigger.cron);
  const time = `${pad(s.hour)}:${pad(s.minute)}`;
  switch (s.preset) {
    case "hour":
      return `${t("everyHour")}, ${t("atMinute")} ${s.minute}`;
    case "day":
      return `${t("everyDay")} ${t("at")} ${time}`;
    case "weekdays":
      return `${t("weekdays")} ${t("at")} ${time}`;
    case "week":
      return `${t("everyWeek")}, ${weekdayName(s.weekday)} ${t("at")} ${time}`;
    case "month":
      return `${t("everyMonth")}, ${s.monthDay} ${t("monthDay")} ${t("at")} ${time}`;
    default:
      return trigger.cron;
  }
}

function weekdayName(day: number): string {
  // 2023-01-01 was a Sunday.
  return new Date(2023, 0, 1 + day).toLocaleDateString(undefined, { weekday: "long" });
}

export function AutomationPage({ id }: { id: string }) {
  const a = useUi((s) => s.data?.automations.find((x) => x.id === id));
  const folder = useUi((s) => s.data?.folders.find((f) => f.id === a?.folderId));
  const process = useUi((s) => s.data?.processes.defs.find((w) => w.id === a?.process));
  const defs = useUi((s) => s.data?.processes.defs ?? []);
  const steps = useUi((s) => s.data?.processes.steps ?? []);
  const runs = useRuns(id);
  const [problems, setProblems] = useState(false);
  if (!a || !folder) return null;
  const shown = problems ? runs.filter((r) => r.result !== "created" || r.task?.process === "failed") : runs;

  return (
    <Page
      icon={<TriggerIcon automation={a} size={16} />}
      title={a.name}
      subtitle={
        <button className="hover:text-text hover:underline" onClick={() => selectFolder(folder.id)}>
          {folder.name}
        </button>
      }
      actions={
        <>
          <label className="mr-2 flex items-center gap-1.5 text-xs text-muted">
            <input
              type="checkbox"
              className="size-3.5 accent-[var(--accent)]"
              checked={a.enabled}
              onChange={(e) => void attempt(() => api.patch(`/api/automations/${a.id}`, { enabled: e.target.checked }))}
            />
            {a.enabled ? t("enabled") : t("paused")}
          </label>
          <Button size="sm" variant="primary" icon={Play} onClick={() => void runNow(a)}>
            {t("runNow")}
          </Button>
          <IconButton icon={Pencil} label={t("editAutomation")} className="size-7" onClick={() => openAutomationDialog(folder, a)} />
          <IconButton icon={Trash2} label={t("deleteAutomation")} className="size-7" onClick={() => confirmDeleteAutomation(a)} />
        </>
      }
    >
      <div className="mb-5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
        <span className="inline-flex items-center gap-1">
          <Workflow size={12} className="text-faint" />
          {process ? processText(process) : a.process ? a.process : t("noProcess")}
        </span>
        <span>{describeTrigger(a.trigger)}</span>
        {a.nextRun && <span>{t("nextRunAt", { when: formatDateTime(a.nextRun) })}</span>}
      </div>
      {a.trigger.kind === "webhook" && <HookAddress automation={a} />}
      {process &&
        (() => {
          const fresh = newQuestions(processQuestions(process, defs, steps), a.seen);
          if (!fresh.length) return null;
          return (
            <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-[color-mix(in_srgb,var(--s-amber)_45%,var(--line))] bg-[color-mix(in_srgb,var(--s-amber)_8%,transparent)] px-3 py-2 text-xs">
              <CircleAlert size={13} className="shrink-0 text-[var(--s-amber)]" />
              <span className="min-w-0 flex-1">
                {t("aq.newQuestion", { n: fresh[0].n, question: questionText(fresh[0].step, fresh[0].question) })}
              </span>
              <Button size="sm" onClick={() => openAutomationDialog(folder, a)}>
                {t("aq.decide")}
              </Button>
            </div>
          );
        })()}
      {a.rejecting && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-danger/40 bg-[color-mix(in_srgb,var(--danger)_8%,transparent)] px-3 py-2 text-xs">
          <CircleAlert size={13} className="shrink-0 text-[var(--danger)]" />
          {t("rejecting")}
        </div>
      )}
      <div className="mb-2 flex items-center gap-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-faint">{t("runs")}</h2>
        <label className="flex items-center gap-1.5 text-xs text-muted">
          <input type="checkbox" className="size-3.5 accent-[var(--accent)]" checked={problems} onChange={(e) => setProblems(e.target.checked)} />
          {t("onlyProblems")}
        </label>
      </div>
      {shown.length === 0 ? (
        <div className="rounded-lg border border-dashed border-line p-6 text-center text-muted">{t("noRuns")}</div>
      ) : (
        <div className="rounded-lg border border-line bg-panel">
          <table className="w-full table-fixed border-collapse text-[13px]">
            <thead className="text-[11px] text-faint">
              <tr className="border-b border-line">
                <th className="w-[18%] px-3 py-1.5 text-left font-medium">{t("colTime")}</th>
                <th className="w-[16%] px-2 py-1.5 text-left font-medium">{t("colHow")}</th>
                <th className="px-2 py-1.5 text-left font-medium">{t("colTitle")}</th>
                <th className="w-[30%] px-2 py-1.5 text-left font-medium">{t("colResult")}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((run) => (
                <RunRow key={run.id} automation={a} run={run} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Page>
  );
}

function RunRow({ automation, run }: { automation: Automation; run: AutomationRunView }) {
  const [open, setOpen] = useState(false);
  const canOpen = !!run.taskId && !!run.task;
  return (
    <>
      <tr
        className="cursor-default border-b border-line/60 last:border-0 hover:bg-hover/50"
        onClick={() => (canOpen ? void openTask(run.taskId!) : run.payload !== null && setOpen(!open))}
      >
        <td className="px-3 py-1.5 text-xs text-muted">{formatDateTime(run.at)}</td>
        <td className="px-2 py-1.5 text-xs text-muted">{t(`how.${run.how}`)}</td>
        <td className="truncate px-2 py-1.5">{run.task?.title ?? <span className="text-faint">—</span>}</td>
        <td className="px-2 py-1.5 text-xs">
          <RunResult automation={automation} run={run} />
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={4} className="px-3 pb-2">
            <pre className="max-h-48 overflow-auto rounded-md border border-line bg-bg p-2 font-mono text-[11px]">{JSON.stringify(run.payload, null, 2)}</pre>
          </td>
        </tr>
      )}
    </>
  );
}

/** What a run came to: its task's status now, or why it made none. */
function RunResult({ run, short }: { automation: Automation; run: AutomationRunView | Automation["lastRun"]; short?: boolean }) {
  const statuses = useUi((s) => s.data?.statuses ?? []);
  if (!run) return null;
  const view = run as AutomationRunView;
  if (run.result === "created") {
    if (short || !view.task) {
      if (!short && !view.task) return <span className="text-faint">{t("taskDeleted")}</span>;
      return <span className="text-muted">{formatWhen(run.at)}</span>;
    }
    const status = statuses.find((s) => s.id === view.task!.status);
    return (
      <span className="inline-flex items-center gap-1.5">
        <StatusDot color={view.task.process === "failed" ? "red" : (status?.color ?? "gray")} />
        {view.task.process === "failed" ? t("processFailedShort") : statusLabel(status, view.task.status)}
        {view.task.archived && <span className="text-faint">· {t("inArchiveShort")}</span>}
      </span>
    );
  }
  const text = run.result === "error" ? t("resultError", { text: run.detail ?? "" }) : t(`detail.${run.detail}`);
  return (
    <span className={cx("truncate", run.result === "error" ? "text-[var(--danger)]" : "text-muted")} title={text}>
      {short ? formatWhen(run.at) + " · " : ""}
      {text}
    </span>
  );
}

function useRuns(id: string): AutomationRunView[] {
  const [runs, setRuns] = useState<AutomationRunView[]>([]);
  useEffect(() => {
    let live = true;
    const load = () => void api.get<AutomationRunView[]>(`/api/automations/${id}/runs`).then((x) => live && setRuns(x)).catch(() => {});
    load();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = onEvent((name) => {
      if (!/^(automation\.|task\.|process\.)/.test(name)) return;
      clearTimeout(timer);
      timer = setTimeout(load, 80);
    });
    return () => {
      live = false;
      off();
      clearTimeout(timer);
    };
  }, [id]);
  return runs;
}

export async function runNow(a: Automation): Promise<void> {
  const run = await attempt(() => api.post<AutomationRunView>(`/api/automations/${a.id}/run`, {}));
  if (!run) return;
  if (run.result === "created" && run.taskId) toast(a.name, "info", { action: { label: t("open"), run: () => void openTask(run.taskId!) } });
  else if (run.result === "error") toast(t("resultError", { text: run.detail ?? "" }), "error");
}

export function setPaused(a: Automation, paused: boolean): void {
  void attempt(() => api.patch(`/api/automations/${a.id}`, { enabled: !paused }));
}

function confirmDeleteAutomation(a: Automation): void {
  showCustomDialog(({ open, onOpenChange }) => {
    const remove = (tasks: "keep" | "archive") => {
      onOpenChange(false);
      void attempt(() => api.del(`/api/automations/${a.id}?tasks=${tasks}`)).then(() => selectFolder(a.folderId));
    };
    return (
      <Dialog open={open} onOpenChange={onOpenChange} title={t("deleteAutomationTitle", { name: a.name })} description={t("deleteAutomationBody")}>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("cancel")}
          </Button>
          <Button onClick={() => remove("archive")}>{t("archiveItsTasks")}</Button>
          <Button variant="danger" onClick={() => remove("keep")}>
            {t("keepTasks")}
          </Button>
        </div>
      </Dialog>
    );
  });
}

/** The webhook's address with copy, new secret, and a curl line to try it. */
function HookAddress({ automation: a }: { automation: Automation }) {
  const url = `${location.origin}${a.hookPath}`;
  const local = /^(127\.|localhost$|\[::1\]$)/.test(location.hostname);
  const verify = a.trigger.kind === "webhook" ? a.trigger.verify : "url";
  const header = verify === "header" ? ` -H 'X-Pitwall-Token: ${a.secret}'` : "";
  const curl = `curl -X POST${header} -H 'Content-Type: application/json' -d '{"title":"Test"}' ${url}`;
  return (
    <div className="mb-5 space-y-2 rounded-lg border border-line bg-panel p-3 text-xs">
      <div className="flex items-center gap-2">
        <span className="w-16 shrink-0 text-faint">{t("address")}</span>
        <code className="min-w-0 flex-1 truncate font-mono text-[12px]">{url}</code>
        <Copyable text={url} />
        <IconButton
          icon={KeyRound}
          label={t("newSecret")}
          onClick={() =>
            showCustomDialog(({ open, onOpenChange }) => (
              <Dialog open={open} onOpenChange={onOpenChange} title={t("newSecret")} description={t("newSecretBody")}>
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" onClick={() => onOpenChange(false)}>
                    {t("cancel")}
                  </Button>
                  <Button
                    variant="danger"
                    onClick={() => {
                      onOpenChange(false);
                      void attempt(() => api.post(`/api/automations/${a.id}/secret`));
                    }}
                  >
                    {t("newSecret")}
                  </Button>
                </div>
              </Dialog>
            ))
          }
        />
      </div>
      {verify !== "url" && (
        <div className="flex items-center gap-2">
          <span className="w-16 shrink-0 text-faint">{t("secret")}</span>
          <code className="min-w-0 flex-1 truncate font-mono text-[12px]">{a.secret}</code>
          <Copyable text={a.secret} />
        </div>
      )}
      {local && <div className="text-[var(--s-amber)]">{t("localOnly")}</div>}
      {!a.lastPayload && (
        <div className="text-muted">
          {t("waitingPayload")} <code className="break-all font-mono text-[11px]">{curl}</code>
        </div>
      )}
    </div>
  );
}

function Copyable({ text }: { text: string }) {
  return (
    <IconButton
      icon={Copy}
      label={t("copy")}
      onClick={() => void navigator.clipboard?.writeText(text).then(() => toast(t("copied")))}
    />
  );
}

// The editor

type Preset = "hour" | "day" | "weekdays" | "week" | "month" | "custom";

interface Schedule {
  preset: Preset;
  minute: number;
  hour: number;
  weekday: number;
  monthDay: number;
  cron: string;
}

/** Reads a cron expression back into the editor's presets. */
export function fromCron(cron: string): Schedule {
  const base = { minute: 0, hour: 9, weekday: 1, monthDay: 1, cron };
  const f = cron.trim().split(/\s+/);
  const num = (x: string | undefined, max: number) => (x !== undefined && /^\d+$/.test(x) && Number(x) <= max ? Number(x) : null);
  if (f.length === 5) {
    const [mi, h, dom, mon, dow] = f;
    const minute = num(mi, 59);
    const hour = num(h, 23);
    if (minute !== null && h === "*" && dom === "*" && mon === "*" && dow === "*") return { ...base, preset: "hour", minute };
    if (minute !== null && hour !== null && mon === "*") {
      if (dom === "*" && dow === "*") return { ...base, preset: "day", minute, hour };
      if (dom === "*" && dow === "1-5") return { ...base, preset: "weekdays", minute, hour };
      const d = num(dow, 7);
      if (dom === "*" && d !== null) return { ...base, preset: "week", minute, hour, weekday: d % 7 };
      const md = num(dom, 31);
      if (md !== null && md >= 1 && dow === "*") return { ...base, preset: "month", minute, hour, monthDay: md };
    }
  }
  return { ...base, preset: "custom" };
}

export function toCron(s: Schedule): string {
  switch (s.preset) {
    case "hour":
      return `${s.minute} * * * *`;
    case "day":
      return `${s.minute} ${s.hour} * * *`;
    case "weekdays":
      return `${s.minute} ${s.hour} * * 1-5`;
    case "week":
      return `${s.minute} ${s.hour} * * ${s.weekday}`;
    case "month":
      return `${s.minute} ${s.hour} ${s.monthDay} * *`;
    default:
      return s.cron;
  }
}

const field = "h-8 rounded-md border border-line bg-bg px-2 text-[13px] outline-none focus:border-accent";

/** Opens the editor: a new automation in the folder, or `existing` to change it. */
export function openAutomationDialog(folder: Folder, existing?: Automation, preset?: { process?: string }): void {
  showCustomDialog(({ open, onOpenChange }) => (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      wide
      title={existing ? t("editAutomation") : t("newAutomationIn", { folder: folder.name })}
    >
      <AutomationEditor folder={folder} existing={existing} preset={preset} close={() => onOpenChange(false)} />
    </Dialog>
  ));
}

function AutomationEditor({ folder, existing, preset, close }: { folder: Folder; existing?: Automation; preset?: { process?: string }; close: () => void }) {
  const data = useUi((s) => s.data);
  const defs = (data?.processes.defs ?? []).filter((w) => !w.template);
  const steps = data?.processes.steps ?? [];
  // The folder's task buttons first: those are the processes it makes tasks with.
  const preferred = data ? folderProcesses(data, folder.id).map((w) => w.process) : [];
  const processes = [...defs].sort((a, b) => {
    const ia = preferred.indexOf(a.id);
    const ib = preferred.indexOf(b.id);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const initial = existing?.trigger;
  const [name, setName] = useState(existing?.name ?? "");
  const [kind, setKind] = useState<AutomationTrigger["kind"]>(initial?.kind ?? "schedule");
  const [schedule, setSchedule] = useState<Schedule>(fromCron(initial?.kind === "schedule" ? initial.cron : "0 9 * * *"));
  const [timezone, setTimezone] = useState(initial?.kind === "schedule" ? initial.timezone : zone);
  const [missed, setMissed] = useState<"skip" | "once">(initial?.kind === "schedule" ? initial.missed : "skip");
  const [verify, setVerify] = useState<"url" | "github" | "header">(initial?.kind === "webhook" ? initial.verify : "url");
  const [filter, setFilter] = useState(initial?.kind === "webhook" ? (initial.filter ?? "") : "");
  const [process, setProcess] = useState<string | null>(existing ? existing.process : (preset?.process ?? preferred[0] ?? null));
  const [title, setTitle] = useState(existing?.title ?? "{{automation}} · {{datetime}}");
  const [body, setBody] = useState(existing?.body ?? "");
  const [answers, setAnswers] = useState<[string, string][]>(Object.entries(existing?.answers ?? {}));
  const [questions, setQuestions] = useState<AutomationConfig["questions"]>(existing?.questions ?? {});
  const [startAgent, setStartAgent] = useState(existing?.startAgent ?? false);
  const [overlap, setOverlap] = useState(existing?.overlap ?? "skip");
  const [view, setView] = useState(existing?.view ?? "group");
  const [archiveAfter, setArchiveAfter] = useState<AutomationConfig["archiveAfter"]>(existing ? existing.archiveAfter : 0);
  const [deleteAfter, setDeleteAfter] = useState<AutomationConfig["deleteAfter"]>(existing ? existing.deleteAfter : "folder");
  const [keepRuns, setKeepRuns] = useState<number | null>(existing?.keepRuns ?? null);
  const [preview, setPreview] = useState<{ next: number[]; error: string | null }>({ next: [], error: null });
  const [error, setError] = useState<string | null>(null);
  // Where a picked payload field goes: the field that had the focus last.
  const target = useRef<{ set: (fn: (v: string) => string) => void; el: HTMLInputElement | HTMLTextAreaElement } | null>(null);

  const cron = toCron(schedule);
  useEffect(() => {
    if (kind !== "schedule") return;
    const timer = setTimeout(
      () => void api.post<{ next: number[]; error: string | null }>("/api/automations/cron", { cron, timezone }).then(setPreview).catch(() => {}),
      200,
    );
    return () => clearTimeout(timer);
  }, [cron, timezone, kind]);

  const config = (): Partial<AutomationConfig> & { name: string; folderId: string } => ({
    folderId: folder.id,
    name: name.trim() || (kind === "webhook" ? t("triggerWebhook") : describeTrigger({ kind: "schedule", cron, timezone, missed })),
    trigger: kind === "schedule" ? { kind, cron, timezone, missed } : { kind, verify, filter: filter.trim() || undefined },
    process,
    title,
    body,
    answers: Object.fromEntries(answers.filter(([k]) => k.trim()).map(([k, v]) => [k.trim(), v])),
    // Only the questions of the process picked; the user decided about all of them now.
    questions: Object.fromEntries(Object.entries(questions).filter(([k]) => asked.some((q) => q.key === k))),
    seen: asked.map((q) => q.key),
    startAgent,
    overlap,
    view,
    archiveAfter,
    deleteAfter,
    keepRuns,
  });

  const save = async (run: boolean) => {
    setError(null);
    try {
      const saved = existing
        ? await api.patch<Automation>(`/api/automations/${existing.id}`, config())
        : await api.post<Automation>("/api/automations", config());
      close();
      selectAutomation(saved.id);
      if (run) void runNow(saved);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const bind = (value: string, set: (fn: (v: string) => string) => void) => ({
    value,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => set(() => e.target.value),
    onFocus: (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => (target.current = { set, el: e.target }),
  });
  const insert = (path: string) => {
    const tgt = target.current ?? { set: (fn: (v: string) => string) => setTitle(fn), el: null as unknown as HTMLInputElement };
    const token = `{{${path}}}`;
    const el = tgt.el;
    const at = el?.selectionStart ?? null;
    tgt.set((v) => (at === null ? v + token : v.slice(0, at) + token + v.slice(el!.selectionEnd ?? at)));
  };

  const payload = existing?.lastPayload;
  const def = defs.find((w) => w.id === process);
  const asked = def ? processQuestions(def, defs, steps) : [];
  const first = asked[0]?.first ? asked[0] : undefined;
  const answerMap = Object.fromEntries(answers);
  const setAnswer = (id: string, fn: (v: string) => string) =>
    setAnswers((all) => (all.some(([k]) => k === id) ? all.map((x) => (x[0] === id ? [x[0], fn(x[1])] : x)) : [...all, [id, fn("")]]));
  const zones = useMemo(() => {
    try {
      return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [zone];
    } catch {
      return [zone];
    }
  }, [zone]);

  return (
    <div className="max-h-[70vh] space-y-4 overflow-y-auto pr-1 text-[13px]">
      <Row label={t("name")}>
        <Input className="h-8" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
      </Row>
      <Row label={t("process")}>
        <select className={cx(field, "w-full")} value={process ?? ""} onChange={(e) => setProcess(e.target.value || null)}>
          <option value="">{t("noProcess")}</option>
          {processes.map((w) => (
            <option key={w.id} value={w.id} disabled={w.problems.length > 0}>
              {processText(w)}
            </option>
          ))}
        </select>
      </Row>
      <Row label={t("trigger")}>
        <div className="flex gap-4">
          {(["schedule", "webhook"] as const).map((k) => (
            <label key={k} className="flex items-center gap-1.5">
              <input type="radio" className="accent-[var(--accent)]" checked={kind === k} onChange={() => setKind(k)} />
              {k === "schedule" ? t("triggerSchedule") : t("triggerWebhook")}
            </label>
          ))}
        </div>
      </Row>

      {kind === "schedule" ? (
        <>
          <Row label={t("when")}>
            <div className="flex flex-wrap items-center gap-2">
              <select className={field} value={schedule.preset} onChange={(e) => setSchedule({ ...schedule, preset: e.target.value as Preset, cron })}>
                <option value="hour">{t("everyHour")}</option>
                <option value="day">{t("everyDay")}</option>
                <option value="weekdays">{t("weekdays")}</option>
                <option value="week">{t("everyWeek")}</option>
                <option value="month">{t("everyMonth")}</option>
                <option value="custom">{t("customCron")}</option>
              </select>
              {schedule.preset === "week" && (
                <select className={field} value={schedule.weekday} onChange={(e) => setSchedule({ ...schedule, weekday: Number(e.target.value) })}>
                  {[1, 2, 3, 4, 5, 6, 0].map((d) => (
                    <option key={d} value={d}>
                      {weekdayName(d)}
                    </option>
                  ))}
                </select>
              )}
              {schedule.preset === "month" && (
                <>
                  <input
                    type="number"
                    min={1}
                    max={31}
                    className={cx(field, "w-16")}
                    value={schedule.monthDay}
                    onChange={(e) => setSchedule({ ...schedule, monthDay: Math.min(31, Math.max(1, Number(e.target.value) || 1)) })}
                  />
                  <span className="text-muted">{t("monthDay")}</span>
                </>
              )}
              {schedule.preset === "hour" && (
                <>
                  <span className="text-muted">{t("atMinute")}</span>
                  <input
                    type="number"
                    min={0}
                    max={59}
                    className={cx(field, "w-16")}
                    value={schedule.minute}
                    onChange={(e) => setSchedule({ ...schedule, minute: Math.min(59, Math.max(0, Number(e.target.value) || 0)) })}
                  />
                </>
              )}
              {["day", "weekdays", "week", "month"].includes(schedule.preset) && (
                <>
                  <span className="text-muted">{t("at")}</span>
                  <input
                    type="time"
                    className={field}
                    value={`${pad(schedule.hour)}:${pad(schedule.minute)}`}
                    onChange={(e) => {
                      const [h, m] = e.target.value.split(":").map(Number);
                      if (!Number.isNaN(h) && !Number.isNaN(m)) setSchedule({ ...schedule, hour: h, minute: m });
                    }}
                  />
                </>
              )}
              {schedule.preset === "custom" && (
                <Input className="h-8 w-48 font-mono" value={schedule.cron} onChange={(e) => setSchedule({ ...schedule, cron: e.target.value })} placeholder="0 3 * * 1-5" />
              )}
            </div>
            <div className={cx("mt-1 text-xs", preview.error ? "text-[var(--danger)]" : "text-muted")}>
              {preview.error ?? (preview.next.length ? t("nextRuns", { list: preview.next.map(formatDateTime).join(", ") }) : "")}
            </div>
          </Row>
          <Row label={t("timezone")}>
            <select className={cx(field, "w-full")} value={timezone} onChange={(e) => setTimezone(e.target.value)}>
              {(zones.includes(timezone) ? zones : [timezone, ...zones]).map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </select>
          </Row>
          <Row label={t("missed")}>
            <div className="flex flex-wrap gap-4">
              {(["skip", "once"] as const).map((m) => (
                <label key={m} className="flex items-center gap-1.5">
                  <input type="radio" className="accent-[var(--accent)]" checked={missed === m} onChange={() => setMissed(m)} />
                  {m === "skip" ? t("missedSkip") : t("missedOnce")}
                </label>
              ))}
            </div>
            <div className="mt-1 text-xs text-faint">{t("scheduleNote")}</div>
          </Row>
        </>
      ) : (
        <>
          <Row label={t("verify")}>
            <select className={cx(field, "w-full")} value={verify} onChange={(e) => setVerify(e.target.value as typeof verify)}>
              <option value="url">{t("verifyUrl")}</option>
              <option value="github">{t("verifyGithub")}</option>
              <option value="header">{t("verifyHeader")}</option>
            </select>
            {!existing && <div className="mt-1 text-xs text-faint">{t("saveFirst")}</div>}
          </Row>
          <Row label={t("filter")}>
            <Input className="h-8 font-mono" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder='payload.action == "opened"' />
            <div className="mt-1 text-xs text-faint">{t("filterHint")}</div>
          </Row>
        </>
      )}

      <Row label={t("taskTitle")}>
        <Input className="h-8" {...bind(title, setTitle)} />
        <div className="mt-1 font-mono text-[11px] text-faint">{t("templateHint")}</div>
      </Row>
      <Row label={t("taskBody")}>
        <textarea className={cx(field, "h-20 w-full resize-y py-1.5")} {...bind(body, setBody)} />
      </Row>
      {kind === "webhook" && payload != null && (
        <Row label={t("lastPayload")}>
          <div className="mb-1 text-xs text-faint">{t("pickField")}</div>
          <div className="max-h-48 overflow-auto rounded-md border border-line bg-bg p-2 font-mono text-[11px]">
            <PayloadTree value={payload} path="payload" onPick={insert} />
          </div>
        </Row>
      )}
      {process && first ? (
        <Row label={t("aq.give")}>
          <div className="space-y-1.5">
            {(first.question.fields ?? []).map((f) => (
              <label key={f.id} className="block">
                <span className="mb-0.5 block text-xs text-muted">
                  {fieldText(first.step, f)}
                  {f.required && <span className="text-[var(--danger)]"> *</span>}
                </span>
                <Input
                  className="h-8"
                  placeholder={f.id === "title" ? t("aq.asTitle") : f.id === "body" || (first.question.fields ?? []).length === 1 ? t("aq.asBody") : t("aq.asks")}
                  {...bind(answerMap[f.id] ?? "", (fn) => setAnswer(f.id, fn))}
                />
              </label>
            ))}
          </div>
          <div className="mt-1 text-xs text-faint">{t("aq.giveHint")}</div>
        </Row>
      ) : null}
      {process && def && (
        <>
          <Row label={t("aq.asksYou")}>
            <QuestionAnswers questions={asked} value={questions} onChange={setQuestions} seen={existing?.seen ?? []} def={def} steps={steps} />
          </Row>
          <Row label={t("aq.result")}>
            <div className="rounded-md bg-raised px-2.5 py-1.5">{summary(asked, questions, fillsFirstForm(first, answerMap))}</div>
          </Row>
        </>
      )}
      {process && !first ? (
        <Row label={t("answers")}>
          <div className="space-y-1.5">
            {answers.map(([k, v], i) => (
              <div key={i} className="flex gap-1.5">
                <Input
                  className="h-8 w-32 font-mono"
                  placeholder={t("fieldId")}
                  value={k}
                  onChange={(e) => setAnswers(answers.map((x, j) => (j === i ? [e.target.value, x[1]] : x)))}
                />
                <Input
                  className="h-8 flex-1"
                  placeholder={t("value")}
                  {...bind(v, (fn) => setAnswers((all) => all.map((x, j) => (j === i ? [x[0], fn(x[1])] : x))))}
                />
                <IconButton icon={Trash2} label={t("remove")} className="size-8" onClick={() => setAnswers(answers.filter((_, j) => j !== i))} />
              </div>
            ))}
            <Button size="sm" variant="ghost" icon={Plus} onClick={() => setAnswers([...answers, ["", ""]])}>
              {t("addAnswer")}
            </Button>
          </div>
          <div className="mt-1 text-xs text-faint">{t("answersHint")}</div>
        </Row>
      ) : (
        <Row label="">
          <label className="flex items-center gap-1.5">
            <input type="checkbox" className="size-3.5 accent-[var(--accent)]" checked={startAgent} onChange={(e) => setStartAgent(e.target.checked)} />
            {t("startAgentOption")}
          </label>
        </Row>
      )}
      <Row label={t("overlap")}>
        <select className={cx(field, "w-full")} value={overlap} onChange={(e) => setOverlap(e.target.value as typeof overlap)}>
          <option value="skip">{t("overlapSkip")}</option>
          <option value="always">{t("overlapAlways")}</option>
        </select>
      </Row>
      <Row label={t("view")}>
        <select className={cx(field, "w-full")} value={view} onChange={(e) => setView(e.target.value as typeof view)}>
          <option value="group">{t("viewGroup")}</option>
          <option value="folder">{t("viewFolder")}</option>
          <option value="hidden">{t("viewHidden")}</option>
        </select>
      </Row>
      <Row label={t("afterDone")}>
        <select
          className={cx(field, "w-full")}
          value={archiveAfter === null ? "null" : String(archiveAfter)}
          onChange={(e) => setArchiveAfter(e.target.value === "null" ? null : e.target.value === "folder" ? "folder" : Number(e.target.value))}
        >
          <option value="0">{t("archiveNow")}</option>
          {[1, 3, 7].map((n) => (
            <option key={n} value={n}>
              {t("archiveAfterDays", { n })}
            </option>
          ))}
          <option value="folder">{t("asFolder")}</option>
          <option value="null">{t("stayInTree")}</option>
        </select>
        <div className="mt-1 text-xs text-faint">{t("failedStay")}</div>
      </Row>
      <Row label={t("inArchive")}>
        <div className="flex flex-wrap items-center gap-2">
          <select
            className={field}
            value={deleteAfter === null ? "null" : String(deleteAfter)}
            onChange={(e) => setDeleteAfter(e.target.value === "null" ? null : e.target.value === "folder" ? "folder" : Number(e.target.value))}
          >
            <option value="folder">{t("asFolder")}</option>
            {[3, 7, 14, 30].map((n) => (
              <option key={n} value={n}>
                {t("deleteAfterDays", { n })}
              </option>
            ))}
            <option value="null">{t("keepForever")}</option>
          </select>
          <span className="text-muted">{t("keepRuns")}</span>
          <select className={field} value={keepRuns ?? ""} onChange={(e) => setKeepRuns(e.target.value ? Number(e.target.value) : null)}>
            <option value="">{t("keepRunsAll")}</option>
            {[5, 10, 20, 50, 100].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
      </Row>
      {error && <div className="rounded-md border border-danger/40 px-3 py-2 text-xs text-[var(--danger)]">{error}</div>}
      <div className="flex justify-end gap-2 pt-1">
        <Button variant="ghost" onClick={close}>
          {t("cancel")}
        </Button>
        {!existing && (
          <Button icon={Play} onClick={() => void save(true)}>
            {t("createAndRun")}
          </Button>
        )}
        <Button variant="primary" onClick={() => void save(false)}>
          {existing ? t("save") : t("create")}
        </Button>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[160px_1fr] items-start gap-3">
      <div className="pt-1.5 text-xs text-muted">{label}</div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** A JSON value with its fields clickable: a click hands the field's path over. */
function PayloadTree({ value, path, onPick }: { value: unknown; path: string; onPick: (path: string) => void }) {
  if (value === null || typeof value !== "object") {
    return (
      <button className="text-left text-accent hover:underline" onClick={() => onPick(path)} title={`{{${path}}}`}>
        {JSON.stringify(value)}
      </button>
    );
  }
  const entries = Array.isArray(value) ? value.slice(0, 20).map((v, i) => [String(i), v] as const) : Object.entries(value).slice(0, 60);
  return (
    <div className="pl-3">
      {entries.map(([k, v]) => (
        <div key={k}>
          <span className="text-faint">{k}: </span>
          {v !== null && typeof v === "object" ? <PayloadTree value={v} path={`${path}.${k}`} onPick={onPick} /> : <PayloadTree value={v} path={`${path}.${k}`} onPick={onPick} />}
        </div>
      ))}
    </div>
  );
}


