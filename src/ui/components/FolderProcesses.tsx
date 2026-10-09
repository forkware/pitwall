// A folder's task buttons: one per process it creates tasks with, the editor that picks them,
// and the new-folder dialog that asks for them along with the name and the agent.
import { ArrowDown, ArrowUp, CircleAlert, FolderPlus, Keyboard, Plus, RotateCcw, Shapes, X } from "lucide-react";
import { DynamicIcon, iconNames, type IconName } from "lucide-react/dynamic.mjs";
import { useMemo, useRef, useState } from "react";
import type { Folder, FolderProcess, ProcessInfo } from "../../sdk/types.ts";
import { api, getState, setState, useUi } from "../api.ts";
import {
  defaultHotkey,
  FALLBACK_ICON,
  folderProcesses,
  hotkeyConflicts,
  MAX_BUTTONS,
  newFolderDefaults,
  newFolderSettings,
  resolve,
  type ResolvedProcess,
} from "../folderProcesses.ts";
import { t } from "../i18n.ts";
import { Slot, type FolderCreateStep } from "../slots.tsx";
import {
  attempt,
  Button,
  cx,
  Dialog,
  IconButton,
  Input,
  MenuItem,
  MenuSeparator,
  showCustomDialog,
} from "../kit/index.tsx";
import { comboOf, enabledShortcuts, formatKeys, isMac } from "../shortcuts.ts";
import { createTask } from "../taskActions.ts";
import { asksText, issueText, processText } from "../processText.ts";

const known = new Set<string>(iconNames);

/** A lucide icon by its kebab-case name; the process icon when there is no such icon. */
export function ProcessIcon({ name, size = 14, className }: { name?: string; size?: number; className?: string }) {
  const icon = (name && known.has(name) ? name : FALLBACK_ICON) as IconName;
  return <DynamicIcon name={icon} size={size} strokeWidth={2} className={className} />;
}

const iconOf = (name: string) =>
  function Icon(props: { size?: number; className?: string }) {
    return <ProcessIcon name={name} {...props} />;
  };

const usable = (w: ResolvedProcess) => !!w.def && w.def.problems.length === 0;

/** Why a process's button does nothing, or undefined when it works. */
function unusable(w: ResolvedProcess): string | undefined {
  if (!w.def) return t("processMissing", { process: w.process });
  if (w.def.issues?.length) return t("processBroken", { problems: issueText(w.def.issues[0], w.def, getState().data) });
  if (w.def.problems.length) return t("processBroken", { problems: w.def.problems.join("; ") });
  return undefined;
}

/** What a process's button says on hover: its name and keys, what it does, how often it asks. */
function hint(w: ResolvedProcess, keys: string): string {
  if (!w.def) return `${w.label}${keys}`;
  const about = processText(w.def, "description");
  return [`${processText(w.def)}${keys}`, about, asksText(w.def.asks ?? 0)].filter(Boolean).join("\n");
}

function useFolderProcesses(folderId: string) {
  // The list is derived, so compare what it is made from.
  const folders = useUi((s) => s.data?.folders);
  const defs = useUi((s) => s.data?.processes.defs);
  const values = useUi((s) => s.data?.settings.values);
  return useMemo(() => folderProcesses(getState().data, folderId), [folders, defs, values, folderId]);
}

/** The buttons in a folder's row, where "New task" was: the first few processes, or "New task" without any. */
export function FolderTaskButtons({ folder }: { folder: Folder }) {
  const list = useFolderProcesses(folder.id);
  if (list.length === 0) {
    return <IconButton icon={Plus} label={t("newTask")} onClick={(e) => (e.stopPropagation(), void createTask(folder.id))} />;
  }
  return (
    <>
      {list.slice(0, MAX_BUTTONS).map((w) => {
        const why = unusable(w);
        const keys = w.hotkey ? ` (${formatKeys(w.hotkey, isMac)})` : "";
        return (
          <IconButton
            key={w.process}
            icon={iconOf(w.icon)}
            label={why ?? hint(w, keys)}
            disabled={!!why}
            className="disabled:opacity-40"
            onClick={(e) => (e.stopPropagation(), void createTask(folder.id, w.process))}
          />
        );
      })}
    </>
  );
}

/** A folder menu's items for new tasks: each of its processes, any other process, a plain task. */
export function FolderTaskMenuItems({ folder }: { folder: Folder }) {
  const list = useFolderProcesses(folder.id);
  const defs = useUi((s) => s.data?.processes.defs ?? []);
  return (
    <>
      {list.length === 0 && (
        <MenuItem icon={Plus} onSelect={() => void createTask(folder.id)}>
          {t("newTask")}
        </MenuItem>
      )}
      {list.filter(usable).map((w) => (
        <MenuItem
          key={w.process}
          icon={iconOf(w.icon)}
          shortcut={w.hotkey ? formatKeys(w.hotkey, isMac) : undefined}
          onSelect={() => void createTask(folder.id, w.process)}
        >
          {w.label}
        </MenuItem>
      ))}
      {defs.length > 0 && (
        <MenuItem icon={Shapes} onSelect={() => openOtherProcess(folder)}>
          {t("otherProcess")}
        </MenuItem>
      )}
      {list.length > 0 && (
        <MenuItem icon={Plus} onSelect={() => void createTask(folder.id)}>
          {t("plainTask")}
        </MenuItem>
      )}
      <MenuSeparator />
    </>
  );
}

/** Every installed process, for a task the folder's buttons do not cover. */
export function openOtherProcess(folder: Folder): void {
  showCustomDialog(({ open, onOpenChange }) => (
    <OtherProcessDialog folder={folder} open={open} onOpenChange={onOpenChange} />
  ));
}

function OtherProcessDialog({
  folder,
  open,
  onOpenChange,
}: {
  folder: Folder;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const defs = useUi((s) => s.data?.processes.defs ?? []);
  const pick = (process?: string) => {
    onOpenChange(false);
    void createTask(folder.id, process);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      wide
      title={t("otherProcessTitle", { folder: folder.name })}
      description={t("otherProcessBody")}
    >
      <ul className="-mx-1 max-h-[55vh] overflow-y-auto">
        {defs.filter((def) => !def.template).map((def) => (
          <li key={def.id}>
            <button
              disabled={def.problems.length > 0}
              onClick={() => pick(def.id)}
              className="flex w-full items-start gap-3 rounded-md px-2 py-2 text-left hover:bg-hover focus-visible:bg-hover focus-visible:outline-none disabled:opacity-50"
            >
              <ProcessIcon name={def.icon} size={16} className="mt-0.5 shrink-0 text-muted" />
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{processText(def)}</span>
                {def.description && <span className="block text-xs text-muted">{processText(def, "description")}</span>}
                <span className="mt-0.5 block text-[11px] text-faint">
                  {def.issues?.length ? issueText(def.issues[0], def, getState().data) : asksText(def.asks ?? 0)}
                </span>
              </span>
            </button>
          </li>
        ))}
        <li>
          <button
            onClick={() => pick()}
            className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left text-muted hover:bg-hover hover:text-text focus-visible:bg-hover focus-visible:outline-none"
          >
            <Plus size={16} className="shrink-0" />
            {t("plainTask")}
          </button>
        </li>
      </ul>
    </Dialog>
  );
}

// The editor

/**
 * Picks a folder's processes: their order, icons and hotkeys. `dim` shows an inherited list fainter;
 * the first change makes it the folder's own.
 */
export function ProcessListEditor({
  value,
  onChange,
  dim,
}: {
  value: FolderProcess[];
  onChange: (value: FolderProcess[]) => void;
  dim?: boolean;
}) {
  const defs = useUi((s) => s.data?.processes.defs ?? []);
  const list = resolve(value, defs);
  const conflicts = hotkeyConflicts(list, enabledShortcuts());
  const rest = defs.filter((d) => !value.some((v) => v.process === d.id));
  const [picking, setPicking] = useState<string | null>(null);

  const change = (i: number, patch: Partial<FolderProcess>) => {
    const next = value.map((v, j) => {
      if (j !== i) return v;
      const merged: FolderProcess = { ...v, ...patch };
      for (const key of ["icon", "hotkey"] as const) if (merged[key] === undefined) delete merged[key];
      return merged;
    });
    onChange(next);
  };
  const move = (i: number, by: number) => {
    const next = [...value];
    const [item] = next.splice(i, 1);
    next.splice(i + by, 0, item);
    onChange(next);
  };

  if (defs.length === 0 && value.length === 0) return <p className="text-xs text-muted">{t("noProcesses")}</p>;

  return (
    <div className={cx(dim && "opacity-70")}>
      {value.length === 0 && <p className="mb-2 text-xs text-muted">{t("emptyProcesses")}</p>}
      <ol className="space-y-1">
        {list.map((w, i) => {
          const why = unusable(w);
          return (
            <li key={w.process} className="rounded-md border border-line bg-bg">
              <div className="flex h-9 items-center gap-1.5 px-1.5">
                <span className="w-4 shrink-0 text-center text-[11px] tabular-nums text-faint">{i + 1}</span>
                <IconButton
                  icon={iconOf(w.icon)}
                  label={t("iconPick")}
                  aria-expanded={picking === w.process}
                  className={cx("size-7", w.ownIcon ? "text-text" : "text-muted")}
                  onClick={() => setPicking(picking === w.process ? null : w.process)}
                />
                <span className={cx("min-w-0 flex-1 truncate", why && "text-faint line-through")} title={why}>
                  {w.label}
                </span>
                {why && <CircleAlert size={13} className="shrink-0 text-[var(--danger)]" aria-label={why} />}
                <HotkeyField
                  value={w.hotkey}
                  own={w.ownHotkey}
                  conflict={conflicts[i]}
                  onChange={(hotkey) => change(i, { hotkey })}
                  fallback={defaultHotkey(w.def, i)}
                />
                <IconButton icon={ArrowUp} label={t("moveUp")} disabled={i === 0} className="disabled:opacity-30" onClick={() => move(i, -1)} />
                <IconButton
                  icon={ArrowDown}
                  label={t("moveDown")}
                  disabled={i === list.length - 1}
                  className="disabled:opacity-30"
                  onClick={() => move(i, 1)}
                />
                <IconButton icon={X} label={t("remove")} onClick={() => onChange(value.filter((_, j) => j !== i))} />
              </div>
              {conflicts[i] && (
                <div className="px-8 pb-1.5 text-[11px] text-[var(--danger)]">{t("hotkeyConflict", { other: conflicts[i] })}</div>
              )}
              {picking === w.process && (
                <IconPicker
                  value={w.ownIcon ? w.icon : undefined}
                  fallback={w.def?.icon ?? FALLBACK_ICON}
                  onChange={(icon) => {
                    change(i, { icon });
                    setPicking(null);
                  }}
                />
              )}
            </li>
          );
        })}
      </ol>
      {rest.length > 0 && (
        <select
          aria-label={t("addProcess")}
          value=""
          onChange={(e) => e.target.value && onChange([...value, { process: e.target.value }])}
          className="mt-2 h-8 w-full rounded-md border border-dashed border-line bg-transparent px-2 text-[13px] text-muted outline-none focus:border-accent"
        >
          <option value="">{t("addProcess")}</option>
          {rest.map((d: ProcessInfo) => (
            <option key={d.id} value={d.id}>
              {d.label}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

/** Records a key combination: Backspace clears it, Escape keeps the old one. */
function HotkeyField({
  value,
  own,
  fallback,
  conflict,
  onChange,
}: {
  value: string;
  own: boolean;
  /** The process's or the position's hotkey, which the reset goes back to. */
  fallback: string;
  conflict?: string;
  onChange: (hotkey: string | undefined) => void;
}) {
  const [recording, setRecording] = useState(false);
  return (
    <span className="flex shrink-0 items-center">
      <button
        type="button"
        // Escape stops the recording rather than closing the dialog; otherwise the dialog takes it.
        data-keep-escape={recording || undefined}
        aria-label={t("hotkey")}
        title={t("hotkeyHelp")}
        onClick={() => setRecording(true)}
        onBlur={() => setRecording(false)}
        onKeyDown={(e) => {
          if (!recording) return;
          e.preventDefault();
          e.stopPropagation();
          if (e.key === "Escape") return setRecording(false);
          if (e.key === "Backspace" || e.key === "Delete") {
            setRecording(false);
            return onChange("");
          }
          const combo = comboOf(e, isMac);
          if (!combo) return;
          setRecording(false);
          onChange(combo === fallback ? undefined : combo);
        }}
        className={cx(
          "inline-flex h-7 min-w-[76px] items-center justify-center gap-1 rounded-md border px-2 font-sans text-[11px] outline-none",
          recording ? "border-accent text-accent" : "border-line text-muted hover:text-text",
          conflict && !recording && "border-[var(--danger)] text-[var(--danger)]",
          !own && !recording && "border-dashed",
        )}
      >
        {recording ? t("hotkeyPress") : value ? formatKeys(value, isMac) : <Keyboard size={12} className="opacity-50" />}
      </button>
      {own ? (
        <IconButton icon={RotateCcw} label={t("hotkeyDefault")} onClick={() => onChange(undefined)} />
      ) : (
        <span className="w-6" />
      )}
    </span>
  );
}

const suggested = [
  "workflow", "list-checks", "bug", "sparkles", "wrench", "rocket", "flask-conical", "git-branch",
  "git-pull-request", "file-text", "pencil", "message-square", "search", "book-open", "lightbulb", "shield-check",
  "test-tube", "package", "terminal", "bot", "zap", "star", "flag", "clipboard-list",
  "calendar", "code", "palette", "database", "globe", "hammer", "notebook-pen", "mail",
].filter((n) => known.has(n));

function IconPicker({
  value,
  fallback,
  onChange,
}: {
  value?: string;
  fallback: string;
  onChange: (icon: string | undefined) => void;
}) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const shown = q ? iconNames.filter((n) => n.includes(q)).slice(0, 48) : suggested;
  return (
    <div className="border-t border-line p-2">
      <div className="flex items-center gap-2">
        <Input
          autoFocus
          className="h-7 flex-1 px-2 text-xs"
          placeholder={t("iconSearch")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          // Enter picks nothing here, rather than sending the form around it.
          onKeyDown={(e) => e.key === "Enter" && e.preventDefault()}
        />
        <Button type="button" size="sm" variant="ghost" onClick={() => onChange(undefined)}>
          <ProcessIcon name={fallback} size={13} />
          {t("iconDefault")}
        </Button>
      </div>
      <div className="mt-2 grid grid-cols-[repeat(auto-fill,minmax(28px,1fr))] gap-1">
        {shown.map((name) => (
          <button
            key={name}
            type="button"
            title={name}
            aria-label={name}
            aria-pressed={name === value}
            onClick={() => onChange(name)}
            className={cx(
              "grid size-7 place-items-center rounded-md text-muted hover:bg-hover hover:text-text focus-visible:outline-2 focus-visible:outline-accent",
              name === value && "bg-hover text-accent",
            )}
          >
            <ProcessIcon name={name} size={15} />
          </button>
        ))}
        {shown.length === 0 && <span className="col-span-full text-xs text-faint">{t("iconNone")}</span>}
      </div>
    </div>
  );
}

// The new-folder dialog

/** Asks for the new folder's name, agent, task buttons and what plugins add, then makes it. */
export function openNewFolderDialog(parentId: string | null): void {
  showCustomDialog(({ open, onOpenChange }) => (
    <NewFolderDialog parentId={parentId} open={open} onOpenChange={onOpenChange} />
  ));
}

function NewFolderDialog({
  parentId,
  open,
  onOpenChange,
}: {
  parentId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const parent = useUi((s) => s.data?.folders.find((f) => f.id === parentId));
  const providers = useUi((s) => s.data?.providers ?? []);
  const [defaults] = useState(() => newFolderDefaults(getState().data, parentId));
  const [name, setName] = useState(t("newFolder"));
  const [provider, setProvider] = useState(defaults.provider);
  const [processes, setProcesses] = useState(defaults.processes);
  const [busy, setBusy] = useState(false);
  // What the plugins' fields do on submit.
  const steps = useRef(new Set<FolderCreateStep>());
  const onCreate = useMemo(
    () => (step: FolderCreateStep) => {
      steps.current.add(step);
      return () => void steps.current.delete(step);
    },
    [],
  );

  const submit = async () => {
    setBusy(true);
    const settings = newFolderSettings(getState().data, parentId, { processes, provider });
    const folder = await attempt(async () => {
      for (const step of steps.current) await step.check?.();
      const made = await api.post<Folder>("/api/folders", { name, parentId, settings });
      // The folder is there whatever a plugin then fails at: close the dialog and say so.
      for (const step of steps.current) await attempt(async () => step.created?.(made));
      return made;
    });
    setBusy(false);
    if (!folder) return;
    onOpenChange(false);
    if (parentId) setState({ collapsed: { ...getState().collapsed, [parentId]: false } });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      wide
      title={parent ? t("newSubfolderTitle", { parent: parent.name }) : t("newFolder")}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="space-y-4"
      >
        <label className="block">
          <span className="mb-1 block text-xs text-muted">{t("folderName")}</span>
          <Input autoFocus onFocus={(e) => e.currentTarget.select()} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <Slot name="folder.create" parentId={parentId} onCreate={onCreate} />
        {providers.length > 0 && (
          <label className="block">
            <span className="mb-1 block text-xs text-muted">{t("setting.defaultProvider")}</span>
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              className="h-9 w-full rounded-md border border-line bg-bg px-2.5 text-[13px] outline-none focus:border-accent"
            >
              {!providers.some((p) => p.id === provider) && <option value={provider}>{provider}</option>}
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                  {p.available ? "" : ` — ${t("agentMissing")}`}
                </option>
              ))}
            </select>
          </label>
        )}
        <div>
          <div className="mb-1 text-xs text-muted">{t("setting.taskProcesses")}</div>
          <p className="mb-2 text-[11px] text-faint">{t("setting.taskProcesses.description")}</p>
          <ProcessListEditor value={processes} onChange={setProcesses} />
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            {t("cancel")}
          </Button>
          <Button type="submit" variant="primary" icon={FolderPlus} disabled={busy || !name.trim()}>
            {t("create")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
