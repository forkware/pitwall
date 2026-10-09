// A step's card in the edit mode: the fields people change most first, the rest under "More".
import { RotateCcw } from "lucide-react";
import type { ReactNode } from "react";
import {
  cx,
  IconButton,
  Input,
  settingValue,
  stepText,
  t,
  TextArea,
  useUi,
  type ParamDef,
  type StepInfo,
  type SwitchSpec,
  type ProcessSpec,
} from "#sdk/ui";
import type { RecipeRow } from "./model.ts";
import { setCase, setNext, setNode, setParam } from "./specs.ts";
import { Field, isSetting, More, Questions } from "./StepCard.tsx";
import { RoleIcon } from "./Recipe.tsx";
import { BranchControls } from "./BuildUi.tsx";
import { NestedSection } from "./Nested.tsx";
import { PENDING, PendingSection } from "./Pending.tsx";
import { nodeName, paramDescription, paramLabel, statusName, valueWords } from "./text.ts";

export const fieldClass =
  "w-full rounded-md border border-line bg-bg px-2.5 py-1.5 text-[13px] outline-none transition-shadow placeholder:text-faint focus:border-accent focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_20%,transparent)]";

export function Select({
  value,
  onChange,
  options,
  label,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  label: string;
  className?: string;
}) {
  return (
    <select aria-label={label} className={cx(fieldClass, "h-8 py-0", className)} value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** The places a way can lead: every step by its number, and the end. */
export function targets(rows: RecipeRow[], self?: string): { value: string; label: string }[] {
  return [
    ...rows.map((r) => ({ value: r.node, label: `${r.n}. ${nodeName(r)}${r.node === self ? ` (${t("we.edit.itself")})` : ""}` })),
    { value: "end", label: t("we.edit.end") },
  ];
}

export function EditCardBody({
  row,
  rows,
  spec,
  steps,
  change,
}: {
  row: RecipeRow;
  rows: RecipeRow[];
  spec: ProcessSpec;
  steps: StepInfo[];
  change: (next: (spec: ProcessSpec) => ProcessSpec) => void;
}) {
  const statuses = useUi((s) => s.data?.statuses ?? []);
  const step = row.step;
  const node = row.spec;
  const edges = spec.edges.filter(([from]) => from === row.node);
  const branch = edges.find(([, to]) => typeof to === "object" && "on" in to)?.[1] as SwitchSpec | undefined;
  const plain = edges.find(([, to]) => typeof to === "string")?.[1] as string | undefined;
  const following = rows[rows.indexOf(row) + 1]?.node ?? "end";
  return (
    <>
      <Field label={t("we.edit.name")}>
        <Input
          className="h-8"
          value={node.label ?? ""}
          placeholder={step ? stepText(step) : row.info.label}
          onChange={(e) => change((s) => setNode(s, row.node, { label: e.target.value || null }))}
        />
      </Field>
      {row.spec.process && <NestedSection row={row} spec={spec} editing change={change} />}
      {row.spec.step === PENDING && <PendingSection row={row} spec={spec} change={change} />}
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
      {step &&
        step.id !== PENDING &&
        Object.entries(step.params).map(([key, def]) => (
          <ParamField
            key={key}
            label={paramLabel(step, key)}
            description={paramDescription(step, key)}
            def={def}
            value={node.params?.[key]}
            onChange={(value) => change((s) => setParam(s, row.node, key, value))}
          />
        ))}
      <Field label={t("we.card.status")}>
        <Select
          label={t("we.card.status")}
          value={node.status ?? ""}
          onChange={(value) => change((s) => setNode(s, row.node, { status: value || null }))}
          options={[{ value: "", label: t("we.card.statusSame") }, ...statuses.map((st) => ({ value: st.id, label: statusName(st.id) }))]}
        />
      </Field>
      <Field label={t("we.card.next")}>
        {branch ? (
          <div className="space-y-1.5">
            {Object.entries(branch.cases).map(([value, to]) => (
              <WayRow
                key={value}
                label={valueWords(step, branch.on, value, row.info)}
                value={to}
                options={targets(rows, row.node)}
                onChange={(next) => change((s) => setCase(s, row.node, value, next))}
              />
            ))}
            <WayRow
              label={t("we.otherwise")}
              value={branch.else ?? ""}
              options={[{ value: "", label: t("we.edit.noOtherwise") }, ...targets(rows, row.node)]}
              onChange={(next) => change((s) => setCase(s, row.node, null, next || null))}
            />
          </div>
        ) : (
          <Select
            label={t("we.card.next")}
            value={plain ?? following}
            onChange={(next) => change((s) => setNext(s, row.node, next))}
            options={targets(rows, row.node).map((o) => (o.value === following ? { ...o, label: `${t("we.card.nextStep")}: ${o.label}` } : o))}
          />
        )}
        <BranchControls row={row} spec={spec} change={change} />
      </Field>
      <label className="flex items-center gap-2 text-[13px]">
        <input
          type="checkbox"
          className="size-3.5 accent-[var(--accent)]"
          checked={!!node.skip}
          onChange={(e) => change((s) => setNode(s, row.node, { skip: e.target.checked || null }))}
        />
        {t("we.edit.skip")}
      </label>
      <More step={step} steps={steps} />
    </>
  );
}

function WayRow({ label, value, options, onChange }: { label: string; value: string; options: { value: string; label: string }[]; onChange: (v: string) => void }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-24 shrink-0 truncate text-xs text-muted" title={label}>
        {label}
      </span>
      <Select label={label} value={value} onChange={onChange} options={options} className="min-w-0 flex-1" />
    </div>
  );
}

/**
 * A parameter: its own value, or the step's default. A default from a setting shows the setting's value as the
 * hint; typing overrides it, and the arrow brings the setting back.
 */
export function ParamField({
  label,
  description,
  def,
  value,
  onChange,
}: {
  label: string;
  description?: string;
  def: ParamDef;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const setting = isSetting(def.default) ? def.default.setting : undefined;
  const fromSetting = useUi((s) => (setting ? settingValue(s, setting) : undefined));
  const own = value !== undefined && !isSetting(value);
  const hint = setting ? t("we.card.fromSetting", { value: String(fromSetting ?? "") || t("we.card.empty") }) : def.placeholder;
  const shown = own ? value : setting ? undefined : def.default;
  const reset = own && (
    <IconButton icon={RotateCcw} label={setting ? t("we.edit.backToSetting") : t("we.edit.backToDefault")} onClick={() => onChange(undefined)} />
  );
  let input: ReactNode;
  switch (def.type) {
    case "boolean":
      input = (
        <label className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" className="size-3.5 accent-[var(--accent)]" checked={!!(shown ?? fromSetting)} onChange={(e) => onChange(e.target.checked)} />
          {label}
        </label>
      );
      break;
    case "select":
      input = (
        <Select
          label={label}
          value={String(shown ?? fromSetting ?? "")}
          onChange={(v) => onChange(v)}
          options={(def.options ?? []).map((o) => ({ value: o.value, label: o.label }))}
        />
      );
      break;
    case "text":
    case "prompt":
      input = (
        <TextArea
          rows={def.type === "prompt" ? 6 : 3}
          className={cx(fieldClass, "resize-y")}
          value={typeof shown === "string" ? shown : ""}
          placeholder={hint}
          onChange={(e) => onChange(e.target.value === "" && !setting ? undefined : e.target.value)}
        />
      );
      break;
    case "number":
      input = (
        <Input
          type="number"
          className="h-8"
          value={shown === undefined ? "" : String(shown)}
          placeholder={hint}
          onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
        />
      );
      break;
    default:
      input = (
        <Input
          className="h-8"
          value={typeof shown === "string" ? shown : ""}
          placeholder={hint}
          onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}
        />
      );
  }
  return (
    <div>
      {def.type !== "boolean" && (
        <div className="mb-1 flex items-center gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-faint">{label}</span>
          <span className="ml-auto">{reset}</span>
        </div>
      )}
      {input}
      {(description ?? def.description) && <div className="mt-1 text-xs text-faint">{description ?? def.description}</div>}
      {setting && !own && <div className="mt-1 text-xs text-faint">{t("we.edit.settingHint")}</div>}
    </div>
  );
}

