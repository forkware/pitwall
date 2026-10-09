// The task's process in its header: where it is, the answers it waits for, the form it asks to fill, and Retry.
import { ChevronDown, Circle, CircleDot, RotateCcw, Square, SquareCheck } from "lucide-react";
import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { FormField, FormValue, Task, UserRequest, ProcessInfo, ProcessRun } from "../../sdk/types.ts";
import { api, getState, useUi } from "../api.ts";
import { clearDraft, loadDraft, saveDraft, type Draft } from "../formDrafts.ts";
import { known, t } from "../i18n.ts";
import { attempt, Button, cx, IconButton, Input, Keys, Menu, MenuContent, MenuItem, MenuTrigger } from "../kit/index.tsx";
import { statusLabel } from "../format.ts";
import { firstLine, waitsForAgent } from "../processHistory.ts";
import { TextArea } from "../TextArea.tsx";
import { formatKeys, isMac, keyCaps, matches } from "../shortcuts.ts";
import { arrowMove, isEmpty, joinChoice, shownSuggestion, splitChoice, takeSuggestion } from "../suggestion.ts";
import { Slot } from "../slots.tsx";
import { treeKeepsFocus } from "../treeKeys.ts";
import { stepText, processText } from "../processText.ts";

/** Sends a form from any of its fields, as in chats; its button shows these keys. */
const SUBMIT_KEYS = "Mod+Enter";

/** The task's last process run, ended or not, and its definition. */
export function useLastRun(task: Task): { run: ProcessRun; def?: ProcessInfo } | undefined {
  const run = useUi((s) => s.data?.processes.runs.find((r) => r.taskId === task.id));
  const def = useUi((s) => s.data?.processes.defs.find((w) => w.id === run?.process));
  return run ? { run, def } : undefined;
}

/** The task's process run and its definition, while it has not ended. */
export function useProcess(task: Task): { run: ProcessRun; def?: ProcessInfo } | undefined {
  const run = useUi((s) => s.data?.processes.runs.find((r) => r.taskId === task.id));
  const def = useUi((s) => s.data?.processes.defs.find((w) => w.id === run?.process));
  return run && run.state !== "done" ? { run, def } : undefined;
}

/** Answers the waiting question; true when the server took the answer. */
const answer = (task: Task, value: unknown) =>
  attempt(async () => {
    await api.post(`/api/tasks/${task.id}/process/resume`, { answer: value });
    return true;
  });

/** The step a run waits on, through the processes it runs inside. */
export function stepOf(run: ProcessRun, def: ProcessInfo | undefined): string | undefined {
  const defs = getState().data?.processes.defs ?? [];
  let current = def;
  let step: string | undefined;
  for (const id of run.path) {
    const node = current?.nodes.find((n) => n.id === id);
    step = node?.step;
    if (node?.process) current = defs.find((d) => d.id === node.process);
  }
  return step;
}

/**
 * A step's question in the user's language: plugins give `question:<step>:<id>`, `field:<step>:<id>` and
 * `option:<step>:<id>` in their strings; what they do not give stays as the step asked it.
 */
export function translated(request: UserRequest, step: string | undefined): UserRequest {
  // A step-by-step trial asks before each step.
  if (request.id === "__step" && request.kind === "choice") {
    return {
      ...request,
      title: t("stepGate", { step: step && known(`step:${step}`) ? t(`step:${step}`) : request.title }),
      options: request.options.map((o) => ({ ...o, label: t(`stepGate.${o.id}`) })),
    };
  }
  if (!step) return request;
  const own = (key: string, fallback: string) => (known(key) ? t(key) : fallback);
  const id = request.id ?? "main";
  // A step waiting for its agent (`pitwall finished`) asks the same everywhere.
  if (id === "agent" && request.kind === "choice" && !known(`question:${step}:agent`)) {
    return {
      ...request,
      title: t("agentWorking"),
      body: t("agentWorkingBody"),
      options: request.options.map((o) => ({ ...o, label: o.id === "done" ? t("agentFinished") : o.label })),
    };
  }
  // A body that is the step's own words (not its output) and a form's button: `question:<step>:<id>:body`, `:submit`.
  const body = request.body === undefined ? undefined : own(`question:${step}:${id}:body`, request.body);
  if (request.kind === "choice") {
    return {
      ...request,
      title: own(`question:${step}:${id}`, request.title),
      body,
      options: request.options.map((o) => ({ ...o, label: own(`option:${step}:${o.id}`, o.label) })),
    };
  }
  return {
    ...request,
    title: own(`question:${step}:${id}`, request.title),
    body,
    submit: request.submit === undefined ? undefined : own(`question:${step}:${id}:submit`, request.submit),
    fields: request.fields.map((f) => ({ ...f, label: own(`field:${step}:${f.id}`, f.label) })),
  };
}

/**
 * Where the task is: its process's name, the step it is on, "step 4 of 9", and the path through the processes
 * that run inside it ("Night triage › Development").
 */
export function useWhere(run: ProcessRun, def: ProcessInfo | undefined) {
  const defs = useUi((s) => s.data?.processes.defs ?? []);
  const steps = useUi((s) => s.data?.processes.steps ?? []);
  const names: string[] = [def ? processText(def) : run.process];
  let current = def;
  let step = run.node ?? "";
  let n = 0;
  run.path.forEach((id, i) => {
    const node = current?.nodes.find((x) => x.id === id);
    if (i === 0) n = (current?.nodes.findIndex((x) => x.id === id) ?? -1) + 1;
    const own = node && steps.find((s) => s.id === node.step);
    step = node ? (own && node.label === own.label ? stepText(own) : node.label) : id;
    if (node?.process && i < run.path.length - 1) {
      current = defs.find((d) => d.id === node.process);
      names.push(current ? processText(current) : node.label);
    }
  });
  return { label: names.join(" › "), step, n, total: def?.nodes.length ?? 0 };
}

/** Where the task is, for the header's line over its name: what it waits on, runs, or failed at. */
export function useWhereText(task: Task, run: ProcessRun, def: ProcessInfo | undefined): { text: string; title: string } {
  const where = useWhere(run, def);
  const request = run.request ? translated(run.request, stepOf(run, def)) : null;
  if (run.state === "failed") {
    const text = t("processFailed", { step: where.step });
    const error = firstLine(run.error);
    return { text: error ? `${text}: ${error}` : text, title: run.error ?? text };
  }
  if (run.state === "waiting" && request) return { text: request.title, title: `${where.label} · ${where.step}` };
  const text = run.progress ? `${where.step}: ${run.progress}` : where.step;
  return { text, title: `${where.label} · ${where.step}` };
}

/** The process's moves for the header: the answers of the question it waits on, or Retry; and plugins' actions. */
export function ProcessActions({ task, run, def }: { task: Task; run: ProcessRun; def?: ProcessInfo }) {
  const sessions = useUi((s) => s.data?.sessions.filter((x) => x.taskId === task.id) ?? []);
  const statuses = useUi((s) => s.data?.statuses ?? []);
  const extra = <Slot name="process.bar" task={task} run={run} />;
  if (run.state === "failed")
    return (
      <>
        {extra}
        <Button size="sm" variant="primary" icon={RotateCcw} onClick={() => void attempt(() => api.post(`/api/tasks/${task.id}/process/retry`))}>
          {t("retry")}
        </Button>
      </>
    );
  const request = run.state === "waiting" && run.request ? translated(run.request, stepOf(run, def)) : null;
  if (request?.kind !== "choice" || waitsForAgent(run, sessions)) return extra;
  const where = (status?: string) => {
    const target = statuses.find((x) => x.id === status);
    return target ? t("movesTo", { status: statusLabel(target) }) : undefined;
  };
  // The first answer always shows; the others fold into a menu when the header is narrow.
  const [first, ...rest] = [...request.options].sort((a, b) => Number(!!b.primary) - Number(!!a.primary));
  const order = request.options;
  return (
    <>
      {extra}
      {order.map((o) => (
        <Button
          key={o.id}
          size="sm"
          variant={o.primary ? "primary" : "secondary"}
          title={where(o.status)}
          className={o.id === first.id ? undefined : "@max-[52rem]:hidden"}
          onClick={() => void answer(task, o.id)}
        >
          {o.label}
        </Button>
      ))}
      {rest.length > 0 && (
        <Menu>
          <MenuTrigger asChild>
            <IconButton icon={ChevronDown} label={t("moreAnswers")} className="size-7 border border-line @min-[52rem]:hidden" />
          </MenuTrigger>
          <MenuContent align="end">
            {rest.map((o) => (
              <MenuItem key={o.id} onSelect={() => void answer(task, o.id)}>
                <span>{o.label}</span>
                {where(o.status) && <span className="ml-auto pl-3 text-xs text-faint">{where(o.status)}</span>}
              </MenuItem>
            ))}
          </MenuContent>
        </Menu>
      )}
    </>
  );
}

/** The answer the task's menu offers while the process waits for the agent ("The agent finished"). */
export function useAgentAnswer(task: Task): { label: string; run: () => void } | null {
  const process = useProcess(task);
  const sessions = useUi((s) => s.data?.sessions.filter((x) => x.taskId === task.id) ?? []);
  if (!process || !waitsForAgent(process.run, sessions) || process.run.request?.kind !== "choice") return null;
  const request = translated(process.run.request, stepOf(process.run, process.def));
  if (request.kind !== "choice") return null;
  const [option] = request.options;
  return { label: option.label, run: () => void answer(task, option.id) };
}

/**
 * Under the header, only while the process waits for the user to read or fill something: a form, or the body
 * of a question (what failed, say). Plugins' hints about the question go under it.
 */
export function ProcessCard({ task }: { task: Task }) {
  const process = useProcess(task);
  const sessions = useUi((s) => s.data?.sessions.filter((x) => x.taskId === task.id) ?? []);
  if (!process || process.run.state !== "waiting" || !process.run.request) return null;
  const { run, def } = process;
  if (waitsForAgent(run, sessions)) return null;
  const request = translated(run.request!, stepOf(run, def));
  const hint = (
    <div className="empty:hidden">
      <Slot name="process.question" task={task} run={run} />
    </div>
  );
  if (request.kind === "choice") {
    // Without a body, only plugins' hints show; the bar is gone when they render nothing.
    if (!request.body)
      return (
        <div className="shrink-0 border-b border-line px-5 py-2 empty:hidden">
          <Slot name="process.question" task={task} run={run} />
        </div>
      );
    return (
      <div className="shrink-0 border-b border-line bg-[color-mix(in_srgb,var(--accent)_5%,transparent)] px-5 py-2.5">
        <Body text={request.body} />
        {hint}
      </div>
    );
  }
  const head = (
    <div className="min-w-0 flex-1">
      <div className="font-medium">{request.title}</div>
      {request.body && <div className="mt-0.5 whitespace-pre-wrap text-xs text-muted">{request.body}</div>}
    </div>
  );
  return (
    <div
      role="region"
      aria-label={request.title}
      className="max-h-[60%] shrink-0 overflow-y-auto border-b border-line bg-[color-mix(in_srgb,var(--accent)_5%,transparent)] px-5 py-3"
    >
      {/* A new question (a new update of the run) starts with an empty form, or with its unsent draft. */}
      <Form key={run.updatedAt} task={task} stamp={run.updatedAt} request={request} head={head} />
      {hint}
    </div>
  );
}

/** A question's body: a few lines, the rest behind "More". */
function Body({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const lines = text.split("\n");
  const long = lines.length > 4;
  return (
    <div className="text-xs text-muted">
      <div className="select-text whitespace-pre-wrap break-words font-mono text-[11.5px]">{open || !long ? text : lines.slice(0, 4).join("\n")}</div>
      {long && (
        <button className="mt-1 text-faint hover:text-text" onClick={() => setOpen(!open)}>
          {open ? t("showLess") : t("showMore", { n: lines.length - 4 })}
        </button>
      )}
    </div>
  );
}

function Form({
  task,
  stamp,
  request,
  head,
}: {
  task: Task;
  stamp: number;
  request: Extract<UserRequest, { kind: "form" }>;
  head: ReactNode;
}) {
  // What was typed survives leaving the task: it is kept as a draft until the form is sent.
  const [values, setValuesState] = useState<Draft>(() => loadDraft(task.id, stamp));
  const setValues = (next: Draft) => {
    setValuesState(next);
    saveDraft(task.id, stamp, next);
  };
  const [busy, setBusy] = useState(false);
  // Opened from the tree, the task's row keeps the focus; else the first field takes it.
  const [focusFirst] = useState(() => !treeKeepsFocus());
  const missing = request.fields.some((f) => f.required && isEmpty(values[f.id]));
  const field =
    "w-full rounded-md border border-line bg-bg px-2.5 py-1.5 text-[13px] outline-none transition-shadow placeholder:text-faint focus:border-accent focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_20%,transparent)]";
  return (
    <form
      className="max-w-[720px]"
      onKeyDown={(e) => {
        if (matches(SUBMIT_KEYS, e, isMac)) {
          e.preventDefault();
          e.currentTarget.requestSubmit();
        }
      }}
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        if (await answer(task, values)) clearDraft(task.id);
        setBusy(false);
      }}
    >
      {head}
      <div className="mt-2.5 space-y-2.5">
        {request.fields.map((f, i) => {
          if (f.options?.length) {
            return (
              <ChoiceField
                key={f.id}
                field={f}
                autoFocus={focusFirst && i === 0}
                value={values[f.id]}
                onChange={(v) => setValues({ ...values, [f.id]: v })}
              />
            );
          }
          const value = typeof values[f.id] === "string" ? (values[f.id] as string) : "";
          const suggestion = typeof f.suggestion === "string" ? shownSuggestion(value, f.suggestion) : undefined;
          const props = {
            autoFocus: focusFirst && i === 0,
            placeholder: (suggestion as string | undefined) ?? f.placeholder,
            value,
            onChange: (e: { target: { value: string } }) => setValues({ ...values, [f.id]: e.target.value }),
            onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
              const taken = typeof f.suggestion === "string" ? takeSuggestion(e, value, f.suggestion) : undefined;
              if (taken === undefined) return;
              e.preventDefault();
              setValues({ ...values, [f.id]: taken });
            },
          };
          return (
            <label key={f.id} className="block">
              <span className="mb-1 block text-xs text-muted">
                {f.label}
                {f.required && <span className="text-[var(--danger)]"> *</span>}
              </span>
              <div className="relative">
                {f.multiline ? (
                  <TextArea rows={3} className={cx(field, "resize-y", suggestion && "pb-6")} {...props} />
                ) : (
                  <Input className={cx("h-8 px-2.5", suggestion && "pr-14")} {...props} />
                )}
                {suggestion && (
                  <span
                    title={t("takeSuggestion")}
                    className={cx(
                      "pointer-events-none absolute flex items-center text-faint",
                      f.multiline ? "bottom-2 right-5" : "right-2 top-1/2 -translate-y-1/2",
                    )}
                  >
                    <Keys keys={["Tab"]} />
                  </span>
                )}
              </div>
            </label>
          );
        })}
      </div>
      <div className="mt-3 flex justify-end">
        <Button
          type="submit"
          size="sm"
          variant="primary"
          disabled={missing || busy}
          title={`${request.submit ?? t("send")} (${formatKeys(SUBMIT_KEYS, isMac)})`}
        >
          {request.submit ?? t("send")}
          <Keys keys={keyCaps(SUBMIT_KEYS, isMac)} />
        </Button>
      </div>
    </form>
  );
}

/**
 * Options to pick, one (radios) or several (checkboxes), and "Other…" with the user's own text when allowed.
 * The suggested options are outlined until something is picked; Tab in the group picks them.
 */
function ChoiceField({
  field,
  value,
  autoFocus,
  onChange,
}: {
  field: FormField;
  value: FormValue | undefined;
  autoFocus?: boolean;
  onChange: (value: FormValue) => void;
}) {
  const options = field.options!;
  const { picked, other } = splitChoice(value, options);
  // The text is kept while "Other…" is off, so turning it back on brings it back.
  const [otherOn, setOtherOn] = useState(other !== undefined);
  const [otherText, setOtherText] = useState(other ?? "");
  const otherRef = useRef<HTMLInputElement>(null);
  const chips = useRef<(HTMLButtonElement | null)[]>([]);
  const count = options.length + (field.other ? 1 : 0);
  // One tab stop per question (the picked option, else the first); arrows move among the options, Space picks.
  const [active, setActive] = useState(() => Math.max(0, otherOn ? options.length : options.findIndex((o) => picked.includes(o))));
  const suggestion = otherOn ? undefined : shownSuggestion(value, field.suggestion);
  const suggested = suggestion === undefined ? [] : Array.isArray(suggestion) ? suggestion : [suggestion];
  const emit = (next: string[], on: boolean, text = otherText) => onChange(joinChoice(next, on ? text : undefined, field.multiple));

  const pick = (o: string) => {
    if (field.multiple) emit(options.filter((x) => (x === o ? !picked.includes(o) : picked.includes(x))), otherOn);
    else {
      setOtherOn(false);
      emit(picked[0] === o ? [] : [o], false);
    }
  };
  const toggleOther = () => {
    const on = !otherOn;
    setOtherOn(on);
    emit(field.multiple ? picked : [], on);
    if (on) setTimeout(() => otherRef.current?.focus());
  };
  const take = (list: string[]) => {
    const own = field.other ? list.find((v) => !options.includes(v)) : undefined;
    const chosen = options.filter((o) => list.includes(o));
    if (own !== undefined && (field.multiple || !chosen.length)) {
      setOtherOn(true);
      setOtherText(own);
      emit(chosen, true, own);
    } else emit(field.multiple ? chosen : chosen.slice(0, 1), false);
  };

  const Icon = (on: boolean) => (field.multiple ? (on ? SquareCheck : Square) : on ? CircleDot : Circle);
  const chip = (on: boolean, hinted: boolean) =>
    cx(
      "inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-[13px] outline-none transition-colors focus-visible:shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_20%,transparent)]",
      on
        ? "border-accent bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] text-text"
        : hinted
          ? "border-dashed border-accent text-muted hover:bg-hover"
          : "border-line text-muted hover:bg-hover",
    );
  return (
    <div
      role={field.multiple ? "group" : "radiogroup"}
      aria-label={field.label}
      onKeyDown={(e) => {
        if (e.target === otherRef.current) return;
        const next = e.altKey || e.ctrlKey || e.metaKey || e.shiftKey ? undefined : arrowMove(e.key, active, count);
        if (next !== undefined) {
          e.preventDefault();
          setActive(next);
          chips.current[next]?.focus();
          return;
        }
        const taken = takeSuggestion(e, value, suggestion);
        if (taken === undefined) return;
        e.preventDefault();
        take(Array.isArray(taken) ? taken : [taken]);
      }}
    >
      <span className="mb-1 block text-xs text-muted">
        {field.label}
        {field.required && <span className="text-[var(--danger)]"> *</span>}
      </span>
      <div className="flex flex-wrap items-center gap-1.5">
        {options.map((o, i) => {
          const on = picked.includes(o);
          const I = Icon(on);
          return (
            <button
              key={o}
              type="button"
              role={field.multiple ? "checkbox" : "radio"}
              aria-checked={on}
              ref={(el) => void (chips.current[i] = el)}
              tabIndex={i === active ? 0 : -1}
              autoFocus={autoFocus && i === active}
              className={chip(on, suggested.includes(o))}
              onFocus={() => setActive(i)}
              onClick={() => pick(o)}
            >
              <I size={13} className={on ? "text-accent" : "text-faint"} />
              {o}
            </button>
          );
        })}
        {field.other && (
          <button
            type="button"
            role={field.multiple ? "checkbox" : "radio"}
            aria-checked={otherOn}
            ref={(el) => void (chips.current[options.length] = el)}
            tabIndex={active === options.length ? 0 : -1}
            className={chip(otherOn, suggested.some((s) => !options.includes(s)))}
            onFocus={() => setActive(options.length)}
            onClick={toggleOther}
          >
            {(() => {
              const I = Icon(otherOn);
              return <I size={13} className={otherOn ? "text-accent" : "text-faint"} />;
            })()}
            {t("otherOption")}
          </button>
        )}
        {suggested.length > 0 && (
          <span title={t("takeSuggestion")} className="flex items-center text-faint">
            <Keys keys={["Tab"]} />
          </span>
        )}
      </div>
      {otherOn && (
        <Input
          ref={otherRef}
          className="mt-1.5 h-8 px-2.5"
          placeholder={t("otherPlaceholder")}
          value={otherText}
          onChange={(e) => {
            setOtherText(e.target.value);
            emit(field.multiple ? picked : [], true, e.target.value);
          }}
        />
      )}
    </div>
  );
}
