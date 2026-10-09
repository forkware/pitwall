// The app's settings page and a folder's page with the settings it can override.
import { RotateCcw, Settings as SettingsIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type { Folder, FolderProcess, SettingDef, SettingValue } from "../../sdk/types.ts";
import { api, useUi } from "../api.ts";
import { t } from "../i18n.ts";
import { attempt, Button, cx, Dialog, IconButton, Input, Section, showCustomDialog } from "../kit/index.tsx";
import { selectFolder, settingValue } from "../sdk.tsx";
import { Slot } from "../slots.tsx";
import { SETTING as TASK_PROCESSES } from "../folderProcesses.ts";
import { ProcessListEditor } from "./FolderProcesses.tsx";

/** A core or plugin setting's label in the UI's language, when one is known. */
function label(def: SettingDef, part: "label" | "description"): string | undefined {
  const key = `setting.${def.key}${part === "description" ? ".description" : ""}`;
  const text = t(key);
  return text === key ? def[part] : text;
}

/** Settings grouped by who defined them: the core first, then plugins in load order. */
function useGroups(filter: (def: SettingDef) => boolean) {
  const defs = useUi((s) => s.data?.settings.defs ?? []).filter(filter);
  const plugins = useUi((s) => s.data?.plugins ?? []);
  const owners = [...new Set(defs.map((d) => d.plugin))];
  return owners.map((owner) => ({
    owner,
    title: owner === "core" ? t("settingsGeneral") : (plugins.find((p) => p.id === owner)?.name ?? owner),
    defs: defs.filter((d) => d.plugin === owner),
  }));
}

export function SettingsView() {
  const groups = useGroups(() => true);
  const values = useUi((s) => s.data?.settings.values ?? {});
  const file = useUi((s) => s.data?.settings.file ?? "");
  return (
    <Page icon={SettingsIcon} title={t("settings")}>
      <p className="-mt-2 mb-6 break-all text-xs text-muted">{t("settingsFile", { file })}</p>
      {groups.map((group) => (
        <Section key={group.owner} title={group.title}>
          {group.defs.map((def) => (
            <AppSetting key={def.key} def={def} current={values[def.key]} />
          ))}
        </Section>
      ))}
    </Page>
  );
}

function AppSetting({ def, current }: { def: SettingDef; current?: SettingValue }) {
  const source = current?.source ?? "default";
  const locked = source === "cli" || source === "env";
  const note = locked
    ? t(source === "cli" ? "settingFromCli" : "settingFromEnv", { name: source === "cli" ? def.key : def.env })
    : source === "default"
      ? t("settingDefault")
      : undefined;
  const put = (value: unknown) => attempt(() => api.put(`/api/settings/${encodeURIComponent(def.key)}`, { value }));
  const save = (value: unknown) => (isRule(def.key) ? saveRule(def.key, value, null, put) : put(value));
  return (
    <Row def={def} note={note} onReset={source === "file" ? () => void save(null) : undefined}>
      <Control def={def} value={current?.value} disabled={locked} onChange={(v) => void save(v)} />
    </Row>
  );
}

/** The folder's settings: the tab "Settings" of its page. */
export function FolderSettings({ folder }: { folder: Folder }) {
  const groups = useGroups((def) => !!def.folder);
  return (
    <div className="mx-auto max-w-[720px]">
      {groups.length > 0 && <p className="mb-6 text-xs text-muted">{t("folderSettingsHint")}</p>}
      {groups.map((group) => (
        <Section key={group.owner} title={group.title}>
          {group.defs.map((def) => (
            <FolderSetting key={def.key} def={def} folder={folder} />
          ))}
        </Section>
      ))}
      <Slot name="folder.settings" folder={folder} />
    </div>
  );
}

function FolderSetting({ def, folder }: { def: SettingDef; folder: Folder }) {
  const own = def.key in folder.settings;
  const inherited = useUi((s) => settingValue(s, def.key, folder.parentId));
  const from = useUi((s) => {
    for (let id = folder.parentId; id; ) {
      const f = s.data?.folders.find((x) => x.id === id);
      if (!f) break;
      if (def.key in f.settings) return f;
      id = f.parentId;
    }
    return undefined;
  });
  const put = (value: unknown) =>
    attempt(() => api.put(`/api/folders/${folder.id}/settings/${encodeURIComponent(def.key)}`, { value }));
  const save = (value: unknown) => (isRule(def.key) && value !== null ? saveRule(def.key, value, folder.id, put) : put(value));
  const note = own ? undefined : from ? (
    <>
      {t("settingInheritedFrom")}{" "}
      <button className="underline decoration-line underline-offset-2 hover:text-text" onClick={() => selectFolder(from.id)}>
        {from.name}
      </button>
    </>
  ) : (
    t("settingInheritedApp")
  );
  return (
    <Row def={def} note={note} onReset={own ? () => void save(null) : undefined}>
      <Control def={def} value={own ? folder.settings[def.key] : inherited} dim={!own} onChange={(v) => void save(v)} />
    </Row>
  );
}

/** A select's option in the interface's language: `setting.<key>.option.<value>`, else as the definition says. */
function optionLabel(key: string, option: { value: string; label: string }): string {
  const id = `setting.${key}.option.${option.value}`;
  const text = t(id);
  return text === id ? option.label : text;
}

// The archive's rules: turning one on shows what it takes at once

const isRule = (key: string) => key === "archiveAfter" || key === "archiveDeleteAfter";

async function saveRule(key: string, value: unknown, folderId: string | null, put: (value: unknown) => Promise<unknown>) {
  if (value === "off") return put(value);
  const hit = await attempt(() => api.post<{ id: string; title: string }[]>("/api/archive/preview", { key, value, folderId }));
  if (!hit) return;
  if (hit.length === 0) return put(value);
  showCustomDialog(({ open, onOpenChange }) => (
    <RulePreview
      open={open}
      onOpenChange={onOpenChange}
      archive={key === "archiveAfter"}
      tasks={hit}
      onConfirm={async (grace) => {
        if (grace) await attempt(() => api.post("/api/archive/hold", { key, value, folderId, days: 7 }));
        await put(value);
        if (!grace) await attempt(() => api.post("/api/archive/sweep"));
      }}
    />
  ));
}

function RulePreview({
  open,
  onOpenChange,
  archive,
  tasks,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  archive: boolean;
  tasks: { id: string; title: string }[];
  onConfirm: (grace: boolean) => void;
}) {
  const [grace, setGrace] = useState(true);
  const [shown, setShown] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={archive ? t("rulePreviewArchive") : t("rulePreviewDelete")}
      description={t("rulePreviewBody", { n: tasks.length })}
    >
      <button className="mb-3 text-xs text-accent hover:underline" onClick={() => setShown(!shown)}>
        {t("showTasks")}
      </button>
      {shown && (
        <ul className="mb-3 max-h-40 overflow-y-auto rounded-md border border-line px-3 py-1.5 text-xs text-muted">
          {tasks.map((x) => (
            <li key={x.id} className="truncate py-0.5">
              {x.title}
            </li>
          ))}
        </ul>
      )}
      <div className="space-y-2 text-[13px]">
        <label className="flex items-center gap-2">
          <input type="radio" className="accent-[var(--accent)]" checked={!grace} onChange={() => setGrace(false)} />
          {archive ? t("ruleNowArchive") : t("ruleNowDelete")}
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" className="accent-[var(--accent)]" checked={grace} onChange={() => setGrace(true)} />
          {t("ruleGrace")}
        </label>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          {t("cancel")}
        </Button>
        <Button
          variant={archive || grace ? "primary" : "danger"}
          onClick={() => {
            onOpenChange(false);
            onConfirm(grace);
          }}
        >
          {t("turnOn")}
        </Button>
      </div>
    </Dialog>
  );
}

// Layout

function Page({
  icon: Icon,
  title,
  subtitle,
  children,
}: {
  icon: typeof SettingsIcon;
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <section className="flex h-full min-w-0 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-5">
        <Icon size={16} className="shrink-0 text-muted" strokeWidth={1.75} />
        <div className="min-w-0">
          {subtitle && <div className="truncate text-[11px] text-faint">{subtitle}</div>}
          <h1 className="truncate text-[15px] font-semibold leading-tight">{title}</h1>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[720px] px-6 py-8">{children}</div>
      </div>
    </section>
  );
}

function Row({
  def,
  note,
  onReset,
  children,
}: {
  def: SettingDef;
  note?: ReactNode;
  onReset?: () => void;
  children: ReactNode;
}) {
  const description = label(def, "description");
  // A list editor needs the row's width: it goes under the label.
  if (def.key === TASK_PROCESSES) {
    return (
      <div className="px-4 py-3.5">
        <div className="flex items-start gap-6">
          <div className="min-w-0 flex-1">
            <div className="font-medium">{label(def, "label")}</div>
            {description && <div className="mt-0.5 text-xs text-muted">{description}</div>}
            {note && <div className="mt-1 text-[11px] text-faint">{note}</div>}
          </div>
          {onReset && <IconButton icon={RotateCcw} label={t("settingReset")} className="size-7" onClick={onReset} />}
        </div>
        <div className="mt-3">{children}</div>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-6 px-4 py-3.5">
      <div className="min-w-0 flex-1">
        <div className="font-medium">{label(def, "label")}</div>
        {description && <div className="mt-0.5 text-xs text-muted">{description}</div>}
        {note && <div className="mt-1 text-[11px] text-faint">{note}</div>}
      </div>
      <div className="flex w-[260px] shrink-0 items-center gap-1">
        <div className="min-w-0 flex-1">{children}</div>
        {onReset ? (
          <IconButton icon={RotateCcw} label={t("settingReset")} className="size-7" onClick={onReset} />
        ) : (
          <span className="w-7" />
        )}
      </div>
    </div>
  );
}

// Controls

const field =
  "h-8 w-full rounded-md border border-line bg-bg px-2.5 text-[13px] outline-none transition-shadow focus:border-accent focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_20%,transparent)] disabled:opacity-60";

function Control({
  def,
  value,
  disabled,
  dim,
  onChange,
}: {
  def: SettingDef;
  value: unknown;
  disabled?: boolean;
  /** The value is inherited: shown fainter until the folder sets its own. */
  dim?: boolean;
  onChange: (value: unknown) => void;
}) {
  const faint = dim && "text-faint";
  switch (def.type) {
    case "boolean":
      return (
        <label className="flex h-8 items-center gap-2">
          <input
            type="checkbox"
            className="size-4 accent-[var(--accent)]"
            checked={value === true}
            disabled={disabled}
            onChange={(e) => onChange(e.target.checked)}
          />
          <span className={cx("text-xs", faint ?? "text-muted")}>{value === true ? t("on") : t("off")}</span>
        </label>
      );
    case "select": {
      const options = def.options ?? [];
      const known = options.some((o) => o.value === value);
      return (
        <select
          className={cx(field, faint)}
          value={String(value ?? "")}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        >
          {!known && <option value={String(value ?? "")}>{String(value ?? "")}</option>}
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {optionLabel(def.key, o)}
            </option>
          ))}
        </select>
      );
    }
    case "json":
      if (def.key === TASK_PROCESSES) {
        return (
          <ProcessListEditor
            value={Array.isArray(value) ? (value as FolderProcess[]) : []}
            dim={dim}
            onChange={(next) => !disabled && onChange(next)}
          />
        );
      }
      return <JsonField value={value} disabled={disabled} className={cx(faint)} onChange={onChange} />;
    default:
      return (
        <TextField
          value={value === undefined || value === null ? "" : String(value)}
          numeric={def.type === "number"}
          disabled={disabled}
          className={cx(faint)}
          onChange={onChange}
        />
      );
  }
}

/** Saves on Enter or when it loses focus, not on every key. */
function TextField({
  value,
  numeric,
  disabled,
  className,
  onChange,
}: {
  value: string;
  numeric?: boolean;
  disabled?: boolean;
  className?: string;
  onChange: (value: unknown) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft === value) return;
    if (!numeric) return onChange(draft);
    const n = Number(draft);
    if (draft.trim() === "" || Number.isNaN(n)) return setDraft(value);
    onChange(n);
  };
  return (
    <Input
      className={cx("h-8 px-2.5", className)}
      inputMode={numeric ? "decimal" : undefined}
      value={draft}
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          setDraft(value);
          e.currentTarget.blur();
        }
      }}
    />
  );
}

function JsonField({
  value,
  disabled,
  className,
  onChange,
}: {
  value: unknown;
  disabled?: boolean;
  className?: string;
  onChange: (value: unknown) => void;
}) {
  const text = value === undefined ? "" : JSON.stringify(value, null, 2);
  const [draft, setDraft] = useState(text);
  const [invalid, setInvalid] = useState(false);
  useEffect(() => setDraft(text), [text]);
  return (
    <textarea
      className={cx(field, "h-24 resize-y py-1.5 font-mono text-xs", invalid && "border-[var(--danger)]", className)}
      value={draft}
      disabled={disabled}
      spellCheck={false}
      onChange={(e) => {
        setDraft(e.target.value);
        setInvalid(false);
      }}
      onBlur={() => {
        if (draft === text) return;
        try {
          onChange(JSON.parse(draft));
        } catch {
          setInvalid(true);
        }
      }}
    />
  );
}
