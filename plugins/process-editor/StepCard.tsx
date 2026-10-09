// A step's card beside the recipe: what it does, what it asks, its settings and where it goes next.
import { ChevronRight, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import { cx, IconButton, keyText, settingValue, stepText, t, useUi, type ParamDef, type StepInfo, type ProcessSpec } from "#sdk/ui";
import type { RecipeRow } from "./model.ts";
import { NextLine, RoleIcon } from "./Recipe.tsx";
import { NestedSection } from "./Nested.tsx";
import { PENDING, PendingSection } from "./Pending.tsx";
import { fieldLabel, nodeName, optionLabel, paramLabel, questionTitle, statusName, whenText } from "./text.ts";

export function CardFrame({ title, onClose, children }: { title: ReactNode; onClose: () => void; children: ReactNode }) {
  return (
    <aside
      className="fixed inset-0 z-40 flex flex-col overflow-y-auto bg-panel lg:static lg:z-auto lg:w-[360px] lg:shrink-0 lg:border-l lg:border-line"
      aria-label={typeof title === "string" ? title : undefined}
    >
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-line bg-panel px-4 py-2.5">
        <div className="min-w-0 flex-1 font-medium">{title}</div>
        <IconButton icon={X} label={t("we.closeCard")} onClick={onClose} />
      </div>
      <div className="space-y-4 px-4 py-3">{children}</div>
    </aside>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-faint">{label}</div>
      <div>{children}</div>
    </div>
  );
}

/** A parameter's value as it will be: the node's own, else the step's default, a setting's value shown as such. */
export function ParamValue({ def, value }: { def: ParamDef; value: unknown }) {
  const setting = isSetting(value) ? value.setting : isSetting(def.default) && value === undefined ? def.default.setting : undefined;
  const settingNow = useUi((s) => (setting ? settingValue(s, setting) : undefined));
  if (setting) return <span className="text-muted">{t("we.card.fromSetting", { value: show(settingNow) || t("we.card.empty") })}</span>;
  const shown = show(value ?? def.default);
  return shown ? <span className="whitespace-pre-wrap break-words">{shown}</span> : <span className="text-faint">{t("we.card.empty")}</span>;
}

export const isSetting = (v: unknown): v is { setting: string } =>
  !!v && typeof v === "object" && typeof (v as { setting?: unknown }).setting === "string";

function show(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "boolean") return v ? t("on") : t("off");
  return typeof v === "string" ? v : JSON.stringify(v);
}

/** What the step gets and gives, in words, folded: most people never need it. */
export function More({ step, steps }: { step?: StepInfo; steps: StepInfo[] }) {
  const [open, setOpen] = useState(false);
  if (!step) return null;
  const words = (keys: string[]) => (keys.length ? keys.map((k) => keyText(k, steps)).join(", ") : t("we.card.nothing"));
  return (
    <div>
      <button className="flex items-center gap-1 text-xs text-muted hover:text-text" onClick={() => setOpen(!open)} aria-expanded={open}>
        <ChevronRight size={12} className={cx("transition-transform", open && "rotate-90")} />
        {t("we.card.more")}
      </button>
      {open && (
        <div className="mt-2 space-y-1.5 text-xs text-muted">
          <div>
            <span className="text-faint">{t("we.card.gets")}:</span> {words(step.reads)}
          </div>
          <div>
            <span className="text-faint">{t("we.card.gives")}:</span> {words(step.writes)}
          </div>
          {step.sideEffects && <div>{t("we.card.sideEffects")}</div>}
          <div className="text-faint">{t("we.card.plugin", { plugin: step.plugin, id: step.id })}</div>
        </div>
      )}
    </div>
  );
}

export function StepCard({
  row,
  steps,
  spec,
  onClose,
  children,
}: {
  row: RecipeRow;
  steps: StepInfo[];
  /** The process the step is in: what a process run as one step can be given. */
  spec?: ProcessSpec;
  onClose: () => void;
  children?: ReactNode;
}) {
  const step = row.step;
  return (
    <CardFrame
      title={
        <span className="flex items-center gap-2">
          <span className="text-xs tabular-nums text-faint">{row.n}</span>
          <RoleIcon row={row} />
          <span className="truncate">{nodeName(row)}</span>
        </span>
      }
      onClose={onClose}
    >
      {children ?? <StepCardBody row={row} steps={steps} spec={spec} />}
    </CardFrame>
  );
}

function StepCardBody({ row, steps, spec }: { row: RecipeRow; steps: StepInfo[]; spec?: ProcessSpec }) {
  const step = row.step;
  if (!step && !row.spec.process) return <p className="text-[var(--danger)]">{t("we.missingStep")}</p>;
  const description = step ? stepText(step, "description") : "";
  return (
    <>
      {row.spec.process && spec && <NestedSection row={row} spec={spec} editing={false} change={() => {}} />}
      {row.spec.step === PENDING && spec && <PendingSection row={row} spec={spec} />}
      {description && <p className="text-muted">{description}</p>}
      <Field label={t("we.card.who")}>
        <span className="inline-flex items-center gap-1.5">
          <RoleIcon row={row} /> {t(`we.who.${row.info.role}`)}
        </span>
      </Field>
      {row.info.questions.length > 0 && (
        <Field label={t("we.card.asks")}>
          <Questions row={row} />
        </Field>
      )}
      {step && step.id !== PENDING && Object.keys(step.params).length > 0 && (
        <Field label={t("we.card.params")}>
          <dl className="space-y-1.5">
            {Object.entries(step.params).map(([key, def]) => (
              <div key={key}>
                <dt className="text-xs text-muted">{paramLabel(step, key)}</dt>
                <dd>
                  <ParamValue def={def} value={row.spec.params?.[key]} />
                </dd>
              </div>
            ))}
          </dl>
        </Field>
      )}
      <Field label={t("we.card.status")}>{row.spec.status ? statusName(row.spec.status) : <span className="text-muted">{t("we.card.statusSame")}</span>}</Field>
      <Field label={t("we.card.next")}>
        {row.next.length ? <NextLine parts={row.next} row={row} /> : <span className="text-muted">{t("we.card.nextStep")}</span>}
      </Field>
      <More step={step} steps={steps} />
    </>
  );
}

/** What the step asks the user, with its buttons. */
export function Questions({ row }: { row: RecipeRow }) {
  const step = row.step;
  const questions = row.info.questions;
  if (!questions.length) return <span className="text-muted">{t("we.card.nothing")}</span>;
  return (
    <ul className="space-y-2">
      {questions.map((q) => (
        <li key={q.id}>
          <div>{questionTitle(step, q)}</div>
          {q.options && (
            <div className="mt-1 flex flex-wrap gap-1">
              {q.options.map((o) => (
                <span key={o.id} className="rounded border border-line px-1.5 py-px text-xs text-muted">
                  {optionLabel(step, o)}
                  {o.status && <span className="text-faint"> → {statusName(o.status)}</span>}
                </span>
              ))}
            </div>
          )}
          {q.fields && <div className="mt-0.5 text-xs text-muted">{q.fields.map((f) => fieldLabel(step, f)).join(", ")}</div>}
          {q.when && <div className="mt-0.5 text-xs text-faint">{t("we.card.sometimes", { when: whenText(step, q) })}</div>}
        </li>
      ))}
    </ul>
  );
}
