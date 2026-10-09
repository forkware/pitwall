// A process's page: what it does, the recipe, the card of the step picked, its problems and where it is used;
// in the edit mode the same page, with a draft that is applied as a whole.
import { Check, CircleAlert, Pencil, Redo2, Repeat, Undo2, Workflow } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  asksText,
  Button,
  confirm,
  cx,
  prompt,
  Dialog,
  EmptyState,
  getState,
  IconButton,
  Input,
  issueText,
  Keys,
  rpc,
  selectAutomation,
  selectFolder,
  showCustomDialog,
  t,
  toast,
  useUi,
  ProcessIcon,
  processText,
  type PageProps,
  stepText,
  type ProcessInfo,
  type ProcessIssue,
  type ProcessSpec,
} from "#sdk/ui";
import { recipe, usesOf, type Uses } from "./model.ts";
import { Page, Tabs } from "./Page.tsx";
import { Recipe } from "./Recipe.tsx";
import { StepCard } from "./StepCard.tsx";
import { EditCardBody } from "./EditCard.tsx";
import { openCatalog, openProcess, originPill, stepsCount, usesText } from "./Catalog.tsx";
import { openDiff } from "./DiffRecipe.tsx";
import { History } from "./History.tsx";
import { MINE_PLUGIN } from "./ids.ts";
import { nodeName } from "./text.ts";
import { applyDraft, useDraft, type DraftState } from "./useDraft.ts";
import { pageExtras, type ProcessTab } from "./pageExtras.tsx";
import { useWide } from "./Schema.tsx";
import { showOriginalUpdate } from "./Updates.tsx";
import { addPicked, pickAndAdd, removeWithUndo } from "./BuildUi.tsx";
import { extractNodes, moveNode } from "./build.ts";
import type { RecipeRow } from "./model.ts";

export function ProcessPage({ params }: PageProps) {
  const id = String(params.id ?? "");
  const def = useUi((s) => s.data?.processes.defs.find((w) => w.id === id));
  if (!def) return <EmptyState icon={Workflow} title={t("we.missingProcess")} body={id} />;
  return <ProcessView key={id} def={def} params={params} />;
}

/** Whether a key press comes from a field, where keys type rather than act. */
const inField = (e: KeyboardEvent) => !!(e.target as Element | null)?.closest?.("input, textarea, select, [contenteditable='true'], .xterm");

function ProcessView({ def, params }: { def: ProcessInfo; params: Record<string, unknown> }) {
  const [tab, setTab] = useState<ProcessTab>((params.tab as ProcessTab) ?? "recipe");
  const draft = useDraft(def);
  const [editing, setEditing] = useState(!!params.edit);
  const data = useUi((s) => s.data);
  const uses = useMemo(() => usesOf(data, def.id), [data, def.id]);
  // A draft left from before opens in the edit mode.
  useEffect(() => {
    if (draft.loaded && draft.dirty) setEditing(true);
  }, [draft.loaded]);
  // Opened again for another step or to change it ("Tune this step" on a task).
  useEffect(() => {
    if (params.edit && def.editable) setEditing(true);
    if (params.node || params.change) setTab("recipe");
  }, [params]);

  const apply = () => openApplyDialog(def, draft, uses);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || (e.target as Element | null)?.closest?.('[role="dialog"], [role="menu"]')) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key === "Enter" && draft.dirty) {
        e.preventDefault();
        apply();
      } else if (inField(e)) return;
      else if (!mod && !e.altKey && e.key.toLowerCase() === "e" && def.editable) {
        e.preventDefault();
        setEditing((x) => !x);
        setTab("recipe");
      } else if (mod && e.key.toLowerCase() === "z" && editing) {
        e.preventDefault();
        if (e.shiftKey) draft.redo();
        else draft.undo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const [trial, setTrial] = useState<string | undefined>(undefined);
  const wide = useWide();
  const [focus, setFocus] = useState<{ node: string } | undefined>(undefined);
  const nav = {
    setTab,
    trial,
    setTrial,
    wide,
    pick: (node: string) => {
      setFocus({ node });
      setTab("recipe");
    },
  };
  const extras = pageExtras(def, draft, nav);
  const tabs: [ProcessTab, string][] = [["recipe", t("we.recipe")], ...extras.tabs, ["history", t("we.history")]];
  const restore = (spec: ProcessSpec) => {
    draft.change({ ...spec, id: def.spec.id, overrides: def.spec.overrides, base: def.spec.base });
    setEditing(true);
    setTab("recipe");
  };
  return (
    <Page
      icon={<ProcessIcon name={def.icon} size={16} className="shrink-0 text-muted" />}
      title={processText(def)}
      subtitle={
        <span className="inline-flex flex-wrap items-center gap-1.5">
          <button className="hover:text-text hover:underline" onClick={() => openCatalog()}>
            {t("we.processes")}
          </button>
          {originPill(def)}
          {def.original && (
            <button className="hover:text-text hover:underline" onClick={() => compareWithOriginal(def)}>
              {t("we.compareOriginal")}
            </button>
          )}
          {def.original?.updated && (
            <button className="rounded px-1 text-[var(--s-amber)] hover:underline" onClick={() => void showOriginalUpdate(def)}>
              {t("we.update.pill")}
            </button>
          )}
        </span>
      }
      tabs={<Tabs value={tab} onChange={setTab} tabs={tabs} />}
      actions={
        <>
          {extras.actions}
          {editing ? (
            <Button size="sm" icon={Check} onClick={() => setEditing(false)} title={`${t("we.edit.done")} (E)`}>
              {t("we.edit.done")}
            </Button>
          ) : (
            <Button
              size="sm"
              icon={Pencil}
              disabled={!def.editable}
              title={def.editable ? `${t("we.edit.start")} (E)` : t("we.edit.codeOnly")}
              onClick={() => {
                setEditing(true);
                setTab("recipe");
              }}
            >
              {t("we.edit.start")}
            </Button>
          )}
        </>
      }
    >
      {tab === "recipe" ? (
        <RecipeTab
          def={def}
          params={params}
          draft={draft}
          editing={editing}
          uses={uses}
          onApply={apply}
          startEditing={() => {
            setEditing(true);
            setTab("recipe");
          }}
          focus={focus}
        />
      ) : tab === "history" ? (
        <div className="overflow-y-auto">
          <History def={def} onRestore={restore} />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">{extras.render(tab)}</div>
      )}
    </Page>
  );
}

function RecipeTab({
  def,
  params,
  draft,
  editing,
  uses,
  onApply,
  startEditing,
  focus,
}: {
  def: ProcessInfo;
  params: Record<string, unknown>;
  draft: DraftState;
  editing: boolean;
  uses: Uses;
  onApply: () => void;
  startEditing: () => void;
  /** A step picked elsewhere (on the schema). */
  focus?: { node: string };
}) {
  const steps = useUi((s) => s.data?.processes.steps ?? []);
  const runs = useUi((s) => (s.data?.processes.runs ?? []).filter((r) => r.process === def.id && r.state !== "done"));
  const [selected, setSelected] = useState<string | undefined>((params.node as string | undefined) ?? undefined);
  const [many, setMany] = useState<string[]>([]);
  useEffect(() => {
    if (focus) setSelected(focus.node);
  }, [focus]);
  useEffect(() => {
    if (!editing) setMany([]);
  }, [editing]);
  useEffect(() => {
    if (params.node && !params.change) setSelected(params.node as string);
  }, [params]);
  const info = draft.info;
  const rows = useMemo(() => recipe(info, draft.spec, steps), [info, draft.spec, steps]);
  const row = rows.find((r) => r.node === selected);
  const marks = useMemo(() => {
    const m: Record<string, "+" | "~"> = {};
    for (const n of draft.diff.added) m[n] = "+";
    for (const n of draft.diff.changed) m[n] = "~";
    return m;
  }, [draft.diff]);
  const extras = pageExtras(def, draft);
  // On the step picked: Insert adds one after it, Del removes it, Alt+arrows move it.
  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => {
      if (inField(e) || (e.target as Element | null)?.closest?.('[role="dialog"], [role="menu"]')) return;
      const at = rows.findIndex((r) => r.node === selected);
      if (at < 0) return;
      if (e.key === "Insert") {
        e.preventDefault();
        const next = rows[at + 1];
        pickAndAdd(draft, def.id, next?.node ?? "end", next ? t("we.pick.before", { n: next.n, name: nodeName(next) }) : t("we.pick.atEnd"), setSelected);
      } else if (e.key === "Delete") {
        e.preventDefault();
        removeWithUndo(draft, rows[at], () => setSelected(undefined));
      } else if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        e.preventDefault();
        draft.change((s) => moveNode(s, rows[at].node, e.key === "ArrowUp" ? -1 : 1));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  return (
    <div className="flex min-h-0 flex-1">
      <div className="min-w-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
        {extras.aboveRecipe({ editing, select: setSelected, startEditing, params, rows })}
        {draft.dirty && <DraftBar draft={draft} onApply={onApply} />}
        {uses.processes.length > 0 && <UsedInside ids={uses.processes} />}
        <Summary def={info} uses={uses} />
        {info.issues.length > 0 && (
          <Problems
            def={info}
            onPick={setSelected}
            fix={
              editing
                ? (issue) => {
                    const writer = (issue.data?.writers as string[] | undefined)?.[0];
                    if (!writer || !issue.node) return;
                    setSelected(addPicked(draft, issue.node, { node: { step: writer }, from: writer }));
                  }
                : undefined
            }
          />
        )}
        <Recipe
          process={info}
          rows={rows}
          selected={selected}
          onSelect={(node) => setSelected(node === selected ? undefined : node)}
          runs={runs}
          highlight={params.taskId as string | undefined}
          doneStatus={draft.spec.doneStatus ?? "done"}
          marks={marks}
          trailing={editing ? (r, i) => extras.between(r, i, rows, setSelected) : undefined}
          picked={editing ? many : undefined}
          onPickMore={editing ? (node) => setMany(many.includes(node) ? many.filter((n) => n !== node) : [...many, node]) : undefined}
        />
        {editing && many.length > 1 && (
          <ExtractBar
            count={many.length}
            onExtract={() => extractToProcess(draft, many, rows, () => setMany([]))}
            onClear={() => setMany([])}
          />
        )}
        {editing && extras.afterRecipe(rows, setSelected)}
        <UsedWhere def={def} uses={uses} />
      </div>
      {row && (
        <StepCard row={row} steps={steps} spec={draft.spec} onClose={() => setSelected(undefined)}>
          {editing ? (
            <>
              <EditCardBody row={row} rows={rows} spec={draft.spec} steps={steps} change={draft.change} />
              {extras.cardActions(row, rows, () => setSelected(undefined), setSelected)}
            </>
          ) : undefined}
        </StepCard>
      )}
    </div>
  );
}

function DraftBar({ draft, onApply }: { draft: DraftState; onApply: () => void }) {
  const problems = draft.info.issues.length;
  return (
    <div
      role="status"
      className="sticky top-0 z-20 -mx-1 mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-[color-mix(in_srgb,var(--accent)_40%,var(--line))] bg-panel px-3 py-2 shadow-lg shadow-black/10"
    >
      <span className="font-medium">{t("we.draft")}</span>
      <span className="text-muted">· {draft.diff.count === 1 ? t("we.draftOne") : t("we.draftChanges", { n: draft.diff.count })}</span>
      {problems > 0 && (
        <span className="inline-flex items-center gap-1 text-[var(--danger)]">
          · <CircleAlert size={12} /> {problems === 1 ? t("we.draftProblem") : t("we.draftProblems", { n: problems })}
        </span>
      )}
      <span className="ml-auto flex items-center gap-1">
        <IconButton icon={Undo2} label={`${t("we.undo")} (Ctrl+Z)`} disabled={!draft.canUndo} onClick={draft.undo} className="disabled:opacity-30" />
        <IconButton icon={Redo2} label={`${t("we.redo")} (Ctrl+Shift+Z)`} disabled={!draft.canRedo} onClick={draft.redo} className="disabled:opacity-30" />
        <Button size="sm" variant="ghost" onClick={() => void draft.discard()}>
          {t("we.discard")}
        </Button>
        <Button size="sm" variant="primary" onClick={onApply}>
          {t("we.apply")}
          <Keys keys={["Ctrl", "↵"]} />
        </Button>
      </span>
    </div>
  );
}

function openApplyDialog(def: ProcessInfo, draft: DraftState, uses: Uses): void {
  showCustomDialog(({ open, onOpenChange }) => <ApplyDialog def={def} draft={draft} uses={uses} open={open} onOpenChange={onOpenChange} />);
}

function ApplyDialog({
  def,
  draft,
  uses,
  open,
  onOpenChange,
}: {
  def: ProcessInfo;
  draft: DraftState;
  uses: Uses;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const running = uses.running.length;
  const where = usesText(uses);
  const plugins = def.plugin !== MINE_PLUGIN && !def.original;
  const problems = draft.info.issues.length > 0;
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t("we.applyTitle")} description={processText(def)}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          const id = await applyDraft(def.id, draft.spec, note);
          setBusy(false);
          if (!id) return;
          draft.reset();
          onOpenChange(false);
          toast(plugins ? t("we.appliedOwn") : t("we.applied"));
          if (id !== def.id) openProcess(id);
        }}
      >
        <ul className="mb-3 space-y-1.5 text-muted">
          {where.length > 0 && <li>{t("we.applyUsed", { where: where.join(", ") })}</li>}
          {running > 0 && <li>{t("we.applyRunning", { n: running })}</li>}
          {plugins && <li>{t("we.applyOwnVersion")}</li>}
          {problems && <li className="text-[var(--danger)]">{t("we.applyProblems")}</li>}
        </ul>
        <label className="block">
          <span className="mb-1 block text-xs text-muted">{t("we.applyNote")}</span>
          <Input autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("we.applyNoteHint")} />
        </label>
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            {t("cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {t("we.apply")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function compareWithOriginal(def: ProcessInfo): void {
  if (!def.original) return;
  openDiff({
    title: t("we.compareOriginal"),
    description: t("we.compareOriginalHint", { plugin: def.original.plugin }),
    before: def.original.spec,
    after: def.spec,
    info: def,
    actions: (close) => (
      <Button
        variant="ghost"
        onClick={() => {
          close();
          confirm({
            title: t("we.revertTitle"),
            description: t("we.revertBody"),
            confirm: t("we.revert"),
            onConfirm: () =>
              void rpc("process-editor", "revert", { id: def.id })
                .then(() => toast(t("we.reverted")))
                .catch((error) => toast((error as Error).message, "error")),
          });
        }}
      >
        {t("we.revert")}
      </Button>
    ),
  });
}

function Summary({ def, uses }: { def: ProcessInfo; uses: Uses }) {
  const running = uses.running.length;
  const defs = useUi((s) => s.data?.processes.defs ?? []);
  const inner = def.nodes.filter((n) => n.process && !n.skip);
  const innerAsks = inner.reduce((sum, n) => sum + n.questions.filter((q) => !q.when).length, 0);
  const innerName = inner.length === 1 ? defs.find((d) => d.id === inner[0].process) : undefined;
  return (
    <div className="mb-5 max-w-3xl">
      {def.description && <p className="text-muted">{processText(def, "description")}</p>}
      <p className="mt-1 text-xs text-faint">
        {stepsCount(def.nodes.length)} · <span className={cx(def.asks > 0 && "text-accent")}>{asksText(def.asks)}</span>
        {innerAsks > 0 &&
          ` ${innerName ? t("we.nested.asksInside", { n: innerAsks, name: processText(innerName) }) : t("we.nested.asksInsideMany", { n: innerAsks })}`}
        {usesText(uses).map((part) => ` · ${part}`)}
        {running > 0 && ` · ${running === 1 ? t("we.runningOne") : t("we.running", { n: running })}`}
      </p>
    </div>
  );
}

function Problems({ def, onPick, fix }: { def: ProcessInfo; onPick: (node: string) => void; fix?: (issue: ProcessIssue) => void }) {
  const steps = useUi((s) => s.data?.processes.steps ?? []);
  return (
    <div className="mb-5 max-w-3xl rounded-lg border border-[color-mix(in_srgb,var(--danger)_45%,var(--line))] bg-[color-mix(in_srgb,var(--danger)_6%,transparent)] px-3 py-2.5">
      <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-[var(--danger)]">
        <CircleAlert size={13} /> {t("we.problems")}
      </div>
      <ul className="space-y-0.5">
        {def.issues.map((issue, i) => {
          const writer = steps.find((x) => x.id === (issue.data?.writers as string[] | undefined)?.[0]);
          return (
            <li key={i} className="flex flex-wrap items-center gap-x-2">
              {issue.node ? (
                <button className="text-left hover:underline" onClick={() => onPick(issue.node!)}>
                  {issueText(issue, def, getState().data)}
                </button>
              ) : (
                issueText(issue, def, getState().data)
              )}
              {fix && issue.code === "unmetRead" && writer && (
                <Button size="sm" variant="ghost" className="h-6 px-1.5 text-accent" onClick={() => fix(issue)}>
                  {t("we.build.addBefore", { step: stepText(writer) })}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function UsedWhere({ def, uses }: { def: ProcessInfo; uses: Uses }) {
  const data = useUi((s) => s.data);
  const items: { key: string; label: string; icon?: ReactNode; run: () => void }[] = [
    ...(uses.app ? [{ key: "app", label: t("we.inAllFolders"), run: () => {} }] : []),
    ...uses.folders.map((id) => ({
      key: id,
      label: t("we.inFolder", { folder: data?.folders.find((f) => f.id === id)?.name ?? "" }),
      run: () => selectFolder(id),
    })),
    ...uses.automations.map((id) => ({
      key: id,
      label: t("we.inAutomation", { name: data?.automations.find((a) => a.id === id)?.name ?? "" }),
      icon: <Repeat size={12} className="text-faint" />,
      run: () => selectAutomation(id),
    })),
    ...uses.processes.map((id) => {
      const w = data?.processes.defs.find((x) => x.id === id);
      return { key: id, label: t("we.inProcess", { name: w ? processText(w) : id }), run: () => openProcess(id) };
    }),
  ];
  return (
    <section className="mt-8 max-w-3xl">
      <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-faint">{t("we.usedWhere")}</h2>
      {items.length === 0 ? (
        <p className="text-muted">{t("we.notUsed")}</p>
      ) : (
        <ul className="space-y-0.5">
          {items.map((item) => (
            <li key={item.key} className="flex items-center gap-1.5">
              {item.icon}
              <button className="text-left text-muted hover:text-text hover:underline" onClick={item.run}>
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      )}
      {pageExtras(def).usedActions}
    </section>
  );
}

/** The processes this one runs inside: a change reaches them too. */
function UsedInside({ ids }: { ids: string[] }) {
  const defs = useUi((s) => s.data?.processes.defs ?? []);
  return (
    <div className="mb-4 max-w-3xl rounded-lg border border-line bg-raised px-3 py-2 text-xs text-muted">
      {t("we.nested.usedInside")}{" "}
      {ids.map((id, i) => {
        const w = defs.find((d) => d.id === id);
        return (
          <span key={id}>
            {i > 0 && ", "}
            <button className="text-text hover:underline" onClick={() => openProcess(id)}>
              {w ? processText(w) : id}
            </button>
          </span>
        );
      })}
      . {t("we.nested.reachesThem")}
    </div>
  );
}

function ExtractBar({ count, onExtract, onClear }: { count: number; onExtract: () => void; onClear: () => void }) {
  return (
    <div className="sticky bottom-2 z-20 mt-3 flex max-w-3xl flex-wrap items-center gap-2 rounded-lg border border-[color-mix(in_srgb,var(--accent)_40%,var(--line))] bg-panel px-3 py-2 shadow-lg shadow-black/10">
      <span>{t("we.nested.picked", { n: count })}</span>
      <span className="ml-auto flex gap-2">
        <Button size="sm" variant="primary" onClick={onExtract}>
          {t("we.nested.extract")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onClear}>
          {t("we.nested.clear")}
        </Button>
      </span>
    </div>
  );
}

/** Takes the picked steps out into a process of the user's own and puts it in their place. */
function extractToProcess(draft: DraftState, picked: string[], rows: RecipeRow[], done: () => void): void {
  const steps = getState().data?.processes.steps ?? [];
  const ordered = rows.filter((r) => picked.includes(r.node)).map((r) => r.node);
  prompt({
    title: t("we.nested.extractTitle"),
    description: t("we.nested.extractBody"),
    initial: nodeName(rows.find((r) => r.node === ordered[0])!),
    onSubmit: async (label) => {
      const keys = (id: string) => {
        const s = steps.find((x) => x.id === id);
        return { reads: s?.reads ?? [], writes: s?.writes ?? [] };
      };
      const tried = extractNodes(draft.spec, ordered, { id: "process", label: label.trim() || t("we.new.name"), process: "__new__" }, keys);
      if ("error" in tried) throw new Error(t(`we.nested.${tried.error}`));
      const id = await rpc<string>("process-editor", "create", { spec: tried.child });
      const parent = {
        ...tried.parent,
        nodes: Object.fromEntries(
          Object.entries(tried.parent.nodes).map(([n, node]) => [n, typeof node === "object" && node.process === "__new__" ? { ...node, process: id } : node]),
        ),
      };
      draft.change(parent);
      done();
      toast(t("we.nested.extracted", { name: label }));
    },
  });
}
