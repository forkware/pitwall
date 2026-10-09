// "What to change?": the user says it in words, an agent changes the recipe, the change shows on the recipe before
// it goes anywhere. Works with any agent: one that has no way to answer without a terminal runs in one nobody sees.
import { CircleAlert, LoaderCircle, MessageCircleQuestion, ShieldQuestion, Sparkles, Square, SquareTerminal, Wrench } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  AgentTerminal,
  Button,
  cx,
  lang,
  onEvent,
  openSettings,
  rpc,
  setSetting,
  t,
  TextArea,
  toast,
  useUi,
  type ProcessInfo,
  type ProcessSpec,
} from "#sdk/ui";
import type { Job } from "./changes.ts";
import { DiffRecipe } from "./DiffRecipe.tsx";
import { fieldClass } from "./EditCard.tsx";
import { askForStep } from "./askForStep.tsx";

export interface ChangeTarget {
  process: string;
  /** What the agent changes: the draft when there is one. */
  spec: ProcessSpec;
  info: ProcessInfo;
  folderId?: string | null;
}

/** Follows a change job by its events. */
function useJob(id: string | null): [Job | null, (job: Job | null) => void] {
  const [job, setJob] = useState<Job | null>(null);
  useEffect(() => {
    if (!id) return;
    return onEvent((name, payload: Job) => name === "process-editor.job" && payload?.id === id && setJob(payload));
  }, [id]);
  return [job, setJob];
}

const elapsed = (from: number) => {
  const s = Math.max(0, Math.floor((Date.now() - from) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export function ChangeField({
  target,
  onTake,
  node,
  focusKey,
  placeholder,
  initial,
  onInitial,
}: {
  target: ChangeTarget;
  /** The user took the proposal: it becomes the draft. */
  onTake: (spec: ProcessSpec) => void;
  /** The step the user points at ("Change this step"). */
  node?: string;
  /** Changes to focus the field. */
  focusKey?: unknown;
  placeholder?: string;
  /** Words to start with at once: "Describe a new process in words". */
  initial?: string;
  /** The words were taken: the page forgets them, so a reload does not start the agent again. */
  onInitial?: () => void;
}) {
  const providers = useUi((s) => s.data?.providers ?? []);
  const [text, setText] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);
  const [request, setRequest] = useState("");
  const [job, setJob] = useJob(jobId);
  const [terminal, setTerminal] = useState(false);
  const [, tick] = useState(0);
  const field = useRef<HTMLTextAreaElement>(null);
  const any = providers.some((p) => p.available);

  useEffect(() => {
    if (focusKey) field.current?.focus();
  }, [focusKey]);
  useEffect(() => {
    if (!initial) return;
    void start(initial);
    onInitial?.();
  }, []);
  // "/" puts the cursor in the field, from anywhere on the page but another field.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
      if ((e.target as Element | null)?.closest?.("input, textarea, select, [contenteditable='true'], .xterm, [role='dialog']")) return;
      e.preventDefault();
      field.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // The clock of a working agent.
  useEffect(() => {
    if (job?.status !== "working" && job?.status !== "silent") return;
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [job?.status]);

  const close = () => {
    if (jobId) void rpc("process-editor", "close", { id: jobId }).catch(() => {});
    setJobId(null);
    setJob(null);
    setTerminal(false);
  };
  const start = async (request: string) => {
    if (!request.trim()) return;
    setRequest(request.trim());
    try {
      const started = await rpc<Job>("process-editor", "change", {
        process: target.process,
        spec: target.spec,
        request: request.trim(),
        node,
        folderId: target.folderId ?? null,
        lang,
      });
      setJobId(started.id);
      setJob(started);
    } catch (error) {
      toast((error as Error).message, "error");
    }
  };
  const send = (name: "reply" | "refine", value: string) =>
    void rpc("process-editor", name, { id: jobId, text: value }).catch((error) => toast((error as Error).message, "error"));

  if (!any) {
    return (
      <div className="mb-5 max-w-3xl rounded-lg border border-dashed border-line px-3 py-2.5 text-muted">
        <span>{t("we.change.noAgent")}</span>
        <Button size="sm" variant="ghost" className="ml-2" onClick={openSettings}>
          {t("we.change.pickAgent")}
        </Button>
      </div>
    );
  }

  const busy = job && ["working", "silent", "permission", "asking"].includes(job.status);
  return (
    <section className="mb-5 max-w-3xl" aria-label={t("we.change.title")}>
      <div className={cx("rounded-lg border bg-panel transition-colors", job ? "border-[color-mix(in_srgb,var(--accent)_45%,var(--line))]" : "border-line")}>
        <div className="flex items-start gap-2 px-3 py-2">
          <Sparkles size={14} className="mt-1.5 shrink-0 text-accent" />
          <div className="min-w-0 flex-1">
          <TextArea
            ref={field}
            rows={1}
            value={text}
            disabled={!!busy}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e: KeyboardEvent<HTMLTextAreaElement>) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                if (job?.status === "proposal" || job?.status === "needsCode" || job?.status === "failed") send("refine", text);
                else void start(text);
                setText("");
              } else if (e.key === "Escape" && job && !busy) close();
            }}
            placeholder={job ? t("we.change.refinePlaceholder") : (placeholder ?? t("we.change.placeholder"))}
            aria-label={t("we.change.title")}
            className="min-h-7 w-full resize-none border-0 bg-transparent px-0 py-1 text-[13px] outline-none placeholder:text-faint"
          />
          </div>
          {!job && <kbd className="mt-1.5 shrink-0 font-sans text-[11px] text-faint">/</kbd>}
        </div>
        {job && (
          <div className="border-t border-line px-3 py-2.5">
            <JobView
              job={job}
              target={target}
              terminal={terminal}
              onTerminal={() => setTerminal(!terminal)}
              onReply={(value) => send("reply", value)}
              onTake={(spec) => {
                onTake(spec);
                close();
                toast(t("we.change.taken"));
              }}
              onRetry={() => {
                close();
                void start(request);
              }}
              onClose={close}
            />
          </div>
        )}
      </div>
      {job && terminal && job.sessionId && (
        <div className="relative mt-2 h-72 overflow-hidden rounded-lg border border-line bg-bg">
          <AgentTerminal sessionId={job.sessionId} visible />
        </div>
      )}
    </section>
  );
}

function JobView({
  job,
  target,
  terminal,
  onTerminal,
  onReply,
  onTake,
  onRetry,
  onClose,
}: {
  job: Job;
  target: ChangeTarget;
  terminal: boolean;
  onTerminal: () => void;
  onReply: (text: string) => void;
  onTake: (spec: ProcessSpec) => void;
  onRetry: () => void;
  onClose: () => void;
}) {
  const [answer, setAnswer] = useState("");
  const showTerminal = job.sessionId && (
    <button className="text-xs text-faint hover:text-text hover:underline" onClick={onTerminal}>
      <SquareTerminal size={12} className="mr-1 inline" />
      {terminal ? t("we.change.hideTerminal") : t("we.change.showTerminal")}
    </button>
  );
  const stop = (
    <Button size="sm" variant="ghost" icon={Square} onClick={() => void rpc("process-editor", "stop", { id: job.id })}>
      {t("we.change.stop")}
    </Button>
  );
  switch (job.status) {
    case "working":
      return (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <LoaderCircle size={14} className="animate-spin text-accent" />
          <span>{t("we.change.thinking")}</span>
          <span className="tabular-nums text-faint">{elapsed(job.startedAt)}</span>
          {job.progress && <span className="min-w-0 truncate text-muted">{job.progress}</span>}
          <span className="ml-auto flex items-center gap-2">
            {showTerminal}
            {stop}
          </span>
        </div>
      );
    case "silent":
      return (
        <div className="flex flex-wrap items-center gap-2">
          <CircleAlert size={14} className="text-[var(--s-amber)]" />
          <span>{t("we.change.silent")}</span>
          <span className="ml-auto flex flex-wrap items-center gap-2">
            {showTerminal}
            <Button size="sm" onClick={() => void rpc("process-editor", "wait", { id: job.id })}>
              {t("we.change.waitMore")}
            </Button>
            {stop}
          </span>
        </div>
      );
    case "permission":
      return (
        <div>
          <div className="flex items-center gap-2">
            <ShieldQuestion size={14} className="text-[var(--s-amber)]" />
            <span>{t("we.change.permission")}</span>
            <span className="ml-auto flex items-center gap-2">
              <Button size="sm" variant="primary" onClick={onTerminal}>
                {terminal ? t("we.change.hideTerminal") : t("we.change.openTerminal")}
              </Button>
              {stop}
            </span>
          </div>
          {job.screen && !terminal && <pre className="mt-2 max-h-32 overflow-auto rounded bg-bg p-2 font-mono text-[11px] text-muted">{tailLines(job.screen, 8)}</pre>}
        </div>
      );
    case "asking":
      return (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!answer.trim()) return;
            onReply(answer.trim());
            setAnswer("");
          }}
        >
          <div className="mb-2 flex items-start gap-2">
            <MessageCircleQuestion size={14} className="mt-0.5 shrink-0 text-accent" />
            <span className="whitespace-pre-wrap">{job.question}</span>
          </div>
          <div className="flex gap-2">
            <input autoFocus className={cx(fieldClass, "h-8 py-0")} value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder={t("we.change.answer")} />
            <Button size="sm" variant="primary" type="submit">
              {t("we.change.send")}
            </Button>
            {stop}
          </div>
        </form>
      );
    case "proposal":
      return (
        <div>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="font-medium">{t("we.change.proposes")}</span>
            <span className="ml-auto flex items-center gap-2">
              <Button size="sm" variant="primary" onClick={() => onTake(job.proposal!.spec)}>
                {t("we.change.take")}
              </Button>
              <Button size="sm" variant="ghost" onClick={onClose}>
                {t("cancel")}
              </Button>
            </span>
          </div>
          <div className="max-h-[50vh] overflow-y-auto rounded-md border border-line bg-bg p-1.5">
            <DiffRecipe before={target.spec} after={job.proposal!.spec} info={target.info} />
          </div>
          {job.proposal!.note && <p className="mt-2 whitespace-pre-wrap text-muted">{job.proposal!.note}</p>}
          {job.proposal!.issues.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-xs text-[var(--danger)]">
              {job.proposal!.issues.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-xs text-faint">{t("we.change.refineHint")}</p>
          <SwitchSuggestion job={job} />
        </div>
      );
    case "needsCode":
      return (
        <div>
          <div className="flex items-start gap-2">
            <Wrench size={14} className="mt-0.5 shrink-0 text-muted" />
            <span>
              {t("we.change.needsCode")} <span className="text-muted">{job.needsCode}</span>
            </span>
          </div>
          <div className="mt-2 flex gap-2">
            <Button size="sm" variant="primary" onClick={() => askForStep(job.needsCode ?? "", target.process)}>
              {t("we.change.askForStep")}
            </Button>
            <Button size="sm" variant="ghost" onClick={onClose}>
              {t("cancel")}
            </Button>
          </div>
          <SwitchSuggestion job={job} />
        </div>
      );
    default:
      return (
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <CircleAlert size={14} className="text-[var(--danger)]" />
            <span>
              {job.status === "stopped" ? t("we.change.stopped") : job.error === "timeout" ? t("we.change.timeout") : t("we.change.failed", { error: job.error ?? "" })}
            </span>
            <span className="ml-auto flex items-center gap-2">
              <Button size="sm" onClick={onRetry}>
                {t("we.change.retry")}
              </Button>
              <Button size="sm" variant="ghost" onClick={onClose}>
                {t("close")}
              </Button>
            </span>
          </div>
          {job.screen && (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs text-muted">{t("we.change.whatItDid")}</summary>
              <pre className="mt-1 max-h-48 overflow-auto rounded bg-bg p-2 font-mono text-[11px] text-muted">{tailLines(job.screen, 30)}</pre>
            </details>
          )}
          <SwitchSuggestion job={job} />
        </div>
      );
  }
}

const tailLines = (text: string, n: number) => text.split("\n").filter((l) => l.trim()).slice(-n).join("\n");

/**
 * Once, after an agent ran in a terminal: one that answers without a terminal is faster. Only installed ones are
 * offered; the folder's agent for tasks stays as it is.
 */
function SwitchSuggestion({ job }: { job: Job }) {
  const providers = useUi((s) => s.data?.providers ?? []);
  const [gone, setGone] = useState(false);
  if (!job.suggestSwitch || job.mode !== "session" || gone) return null;
  const better = providers.filter((p) => p.available && p.exec && p.id !== job.provider);
  const snooze = (never: boolean) => {
    setGone(true);
    void rpc("process-editor", "snoozeSwitch", { never }).catch(() => {});
  };
  return (
    <div className="mt-3 rounded-md border border-line bg-raised px-3 py-2 text-xs">
      <p className="text-muted">{better.length ? t("we.change.switch") : t("we.change.switchNone")}</p>
      <div className="mt-1.5 flex flex-wrap gap-2">
        {better.map((p) => (
          <Button
            key={p.id}
            size="sm"
            onClick={() =>
              void setSetting("process-editor.agent", p.id).then(() => {
                snooze(true);
                toast(t("we.change.switched", { agent: p.label }));
              })
            }
          >
            {t("we.change.use", { agent: p.label })}
          </Button>
        ))}
        {better.length > 0 && (
          <Button size="sm" variant="ghost" onClick={() => snooze(false)}>
            {t("we.change.notNow")}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => snooze(true)}>
          {better.length ? t("we.change.never") : t("close")}
        </Button>
      </div>
    </div>
  );
}
