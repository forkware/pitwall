// What the editor's parts add to a process's page: tabs, header buttons, what goes around the recipe in the edit
// mode, and actions under "Where it is used".
import { FlaskConical, ListPlus, Play, Repeat } from "lucide-react";
import type { ReactNode } from "react";
import { Button, getState, t, type ProcessInfo } from "#sdk/ui";
import type { RecipeRow } from "./model.ts";
import { usesOf } from "./model.ts";
import type { DraftState } from "./useDraft.ts";
import { ChangeField } from "./ChangeField.tsx";
import { nodeName } from "./text.ts";
import { AddAtEnd, Between, CardActions, pickAndAdd } from "./BuildUi.tsx";
import { openTrial, TrialsTab } from "./Trials.tsx";
import { openAddToFolder, openAutomate, openCreateTask } from "./FolderActions.tsx";
import { openProcess } from "./Catalog.tsx";
import { SchemaView } from "./Schema.tsx";
import { HeaderMenu } from "./HeaderMenu.tsx";

export type ProcessTab = "recipe" | "schema" | "history" | "trials";

/** What the page lets its parts change: the tab, and the trial shown in "Trials". */
export interface PageNav {
  setTab: (tab: ProcessTab) => void;
  trial?: string;
  setTrial: (taskId: string) => void;
  /** Wide enough for the schema. */
  wide: boolean;
  /** Opens the recipe with a step's card. */
  pick: (node: string) => void;
}

export interface AboveRecipe {
  editing: boolean;
  select: (node: string) => void;
  startEditing: () => void;
  params: Record<string, unknown>;
  rows: RecipeRow[];
}

export interface PageExtras {
  tabs: [ProcessTab, string][];
  actions: ReactNode;
  usedActions: ReactNode;
  render: (tab: ProcessTab) => ReactNode;
  /** Above the recipe: the "What to change?" field. */
  aboveRecipe: (props: AboveRecipe) => ReactNode;
  /** Between two steps in the edit mode: the "+". */
  between: (row: RecipeRow, index: number, rows: RecipeRow[], select: (node: string) => void) => ReactNode;
  afterRecipe: (rows: RecipeRow[], select: (node: string) => void) => ReactNode;
  /** At the bottom of a step's card in the edit mode: move, duplicate, remove. */
  cardActions: (row: RecipeRow, rows: RecipeRow[], close: () => void, select: (node: string) => void) => ReactNode;
}

/** The folder an agent changing the process works for: the one it was opened from, else one that uses it. */
const folderOf = (def: ProcessInfo, params: Record<string, unknown>) =>
  (params.folderId as string | undefined) ?? usesOf(getState().data, def.id).folders[0] ?? null;

export function pageExtras(def: ProcessInfo, draft?: DraftState, nav?: PageNav): PageExtras {
  const trial = () =>
    draft &&
    nav &&
    openTrial(def, draft.spec, (taskId) => {
      nav.setTrial(taskId);
      nav.setTab("trials");
    });
  return {
    tabs: [...(nav?.wide ? ([["schema", t("we.schema")]] as [ProcessTab, string][]) : []), ["trials", t("we.trials")]],
    actions: draft ? (
      <>
        <Button size="sm" variant="ghost" icon={FlaskConical} onClick={trial} title={t("we.trial.hint")}>
          <span className="hidden sm:inline">{t("we.trial.title")}</span>
        </Button>
        <HeaderMenu def={def} />
      </>
    ) : null,
    usedActions: (
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" icon={ListPlus} onClick={() => openAddToFolder(def)}>
          {t("we.folder.addTitle")}
        </Button>
        <Button size="sm" variant="ghost" icon={Play} disabled={def.problems.length > 0} onClick={() => openCreateTask(def)}>
          {t("we.folder.createTitle")}
        </Button>
        <Button size="sm" variant="ghost" icon={Repeat} disabled={def.problems.length > 0} onClick={() => openAutomate(def)}>
          {t("we.folder.automateTitle")}
        </Button>
      </div>
    ),
    render: (tab) =>
      tab === "trials" && nav ? (
        <TrialsTab def={def} picked={nav.trial} onPick={nav.setTrial} onNew={() => trial()} />
      ) : tab === "schema" && nav && draft ? (
        <SchemaView def={draft.info} spec={draft.spec} onPick={nav.pick} />
      ) : null,
    aboveRecipe: ({ startEditing, params, rows }) => {
      if (!draft || !def.editable) return null;
      const node = params.node as string | undefined;
      const row = node && params.change ? rows.find((r) => r.node === node) : undefined;
      return (
        <ChangeField
          key={String(params.change ?? "")}
          target={{ process: def.id, spec: draft.spec, info: draft.info, folderId: folderOf(def, params) }}
          node={row ? node : undefined}
          focusKey={params.change}
          initial={typeof params.request === "string" ? params.request : undefined}
          onInitial={() => openProcess(def.id, { ...params, request: undefined })}
          placeholder={row ? t("we.change.stepPlaceholder", { n: row.n, name: nodeName(row) }) : undefined}
          onTake={(spec) => {
            // Taking the original's changes in: the version made from is the original's current one now.
            draft.change(params.rebase && def.original?.version ? { ...spec, base: def.original.version } : spec);
            startEditing();
          }}
        />
      );
    },
    between: (row, i, rows, select) => {
      const next = rows[i + 1];
      if (!draft || !next) return null;
      const where = t("we.pick.before", { n: next.n, name: nodeName(next) });
      return <Between next={next.node} where={where} onAdd={() => pickAndAdd(draft, def.id, next.node, where, select)} />;
    },
    afterRecipe: (rows, select) => (draft ? <AddAtEnd draft={draft} self={def.id} rows={rows} select={select} /> : null),
    cardActions: (row, rows, close, select) => (draft ? <CardActions row={row} rows={rows} draft={draft} close={close} select={select} /> : null),
  };
}
