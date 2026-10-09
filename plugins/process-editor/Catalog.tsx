// The catalog: every process as a card that says what it does, how often it asks you and where it is used.
import { CircleAlert, MoreHorizontal, Search, Shapes, Workflow } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import {
  asksText,
  Button,
  cx,
  EmptyState,
  getState,
  IconButton,
  Input,
  issueText,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  openPage,
  plural,
  t,
  useUi,
  ProcessIcon,
  processText,
  type PageProps,
  type ProcessInfo,
} from "#sdk/ui";
import { searchText, usesOf, type Uses } from "./model.ts";
import { Page, Pill, Tabs } from "./Page.tsx";
import { stepName } from "./text.ts";
import { catalogExtras, cardMenuExtras, StepsTab } from "./extensions.tsx";
import { copyAsMine } from "./NewProcess.tsx";

type Filter = "all" | "mine" | "plugins" | "problems";
type Tab = "processes" | "steps";

export const openProcess = (id: string, params: Record<string, unknown> = {}) => openPage("process-editor", "process", { id, ...params });
export const openCatalog = (tab: Tab = "processes") => openPage("process-editor", "catalog", { tab });

export function CatalogPage({ params }: PageProps) {
  const [tab, setTab] = useState<Tab>((params.tab as Tab) ?? "processes");
  return (
    <Page
      icon={<Workflow size={16} className="shrink-0 text-muted" strokeWidth={1.75} />}
      title={t("we.processes")}
      tabs={
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            ["processes", t("we.tabProcesses")],
            ["steps", t("we.tabSteps")],
          ]}
        />
      }
      actions={catalogExtras.actions()}
    >
      {tab === "processes" ? <Processes /> : <StepsTab />}
    </Page>
  );
}

function Processes() {
  const defs = useUi((s) => s.data?.processes.defs ?? []);
  const steps = useUi((s) => s.data?.processes.steps ?? []);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const shown = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return defs
      .filter((w) => !w.template)
      .filter((w) => {
        if (filter === "mine") return w.plugin === "my-processes";
        if (filter === "plugins") return w.plugin !== "my-processes";
        if (filter === "problems") return w.problems.length > 0;
        return true;
      })
      .filter((w) => {
        const text = `${searchText(w, steps, (l) => l)} ${processText(w)} ${w.nodes.map((n) => stepName(steps.find((s) => s.id === n.step))).join(" ")}`.toLowerCase();
        return words.every((word) => text.includes(word));
      })
      .sort((a, b) => processText(a).localeCompare(processText(b)));
  }, [defs, steps, query, filter]);
  const templates = defs.filter((w) => w.template);

  if (defs.length === 0) {
    return <EmptyState icon={Shapes} title={t("we.emptyTitle")} body={t("we.emptyBody")}>{catalogExtras.empty()}</EmptyState>;
  }
  const filters: [Filter, string][] = [
    ["all", t("we.all")],
    ["mine", t("we.mine")],
    ["plugins", t("we.fromPlugins")],
    ["problems", t("we.withProblems")],
  ];
  return (
    <div className="px-4 py-4 sm:px-6 sm:py-5">
      <p className="mb-4 max-w-2xl text-muted">{t("we.catalogHint")}</p>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-72">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
          <Input className="h-8 pl-8" placeholder={t("we.find")} value={query} onChange={(e) => setQuery(e.target.value)} aria-label={t("we.find")} />
        </div>
        <div role="radiogroup" className="flex flex-wrap gap-1">
          {filters.map(([id, label]) => (
            <button
              key={id}
              role="radio"
              aria-checked={filter === id}
              onClick={() => setFilter(id)}
              className={cx(
                "h-7 rounded-md px-2.5 text-xs transition-colors",
                filter === id ? "bg-hover text-text" : "text-muted hover:bg-hover/60 hover:text-text",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-6 lg:flex-row">
        <div className="min-w-0 flex-1">
          {shown.length === 0 ? (
            <div className="rounded-lg border border-dashed border-line p-6 text-center text-muted">{t("we.nothingFound")}</div>
          ) : (
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">
              {shown.map((w) => (
                <li key={w.id}>
                  <Card process={w} />
                </li>
              ))}
            </ul>
          )}
        </div>
        {templates.length > 0 && (
          <aside className="w-full shrink-0 lg:w-64">
            <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-faint">{t("we.templates")}</h2>
            <ul className="space-y-1">
              {templates.map((w) => (
                <li key={w.id} className="group flex items-start gap-1 rounded-md hover:bg-hover">
                  <button
                    onClick={() => openProcess(w.id)}
                    className="flex min-w-0 flex-1 items-start gap-2 px-2 py-1.5 text-left focus-visible:outline-none"
                  >
                    <ProcessIcon name={w.icon} size={14} className="mt-0.5 shrink-0 text-muted" />
                    <span className="min-w-0">
                      <span className="block">{processText(w)}</span>
                      {w.description && <span className="block text-xs text-muted">{processText(w, "description")}</span>}
                    </span>
                  </button>
                  <Button size="sm" variant="ghost" className="mr-1 mt-1 h-6 px-1.5 text-accent" onClick={() => void copyAsMine(w)}>
                    {t("we.useTemplate")}
                  </Button>
                </li>
              ))}
            </ul>
          </aside>
        )}
      </div>
    </div>
  );
}

/** Where it is used, in a few words: "3 folders · 1 automation · 4 tasks now". */
export function usesText(uses: Uses): string[] {
  const parts: string[] = [];
  if (uses.app) parts.push(t("we.usedAll"));
  else if (uses.folders.length) parts.push(uses.folders.length === 1 ? t("we.usedFolder") : t("we.usedFolders", { n: uses.folders.length }));
  if (uses.automations.length) parts.push(uses.automations.length === 1 ? t("we.usedAutomation") : t("we.usedAutomations", { n: uses.automations.length }));
  if (uses.processes.length) parts.push(t("we.usedInside", { n: uses.processes.length }));
  return parts;
}

export function stepsCount(n: number): string {
  if (n === 1) return t("we.oneStep");
  return t(plural(n) === "few" ? "we.stepsFew" : "we.steps", { n });
}

/** Where the process comes from: a plugin, the user, the user's version of a plugin's one, code. */
export function originPill(w: ProcessInfo): ReactNode {
  if (w.original?.updated) {
    return (
      <>
        <Pill tone="accent">{t("we.changedByYou")}</Pill>
        <Pill tone="muted">{t("we.update.pill")}</Pill>
      </>
    );
  }
  if (w.original) return <Pill tone="accent">{t("we.changedByYou")}</Pill>;
  if (w.plugin === "my-processes") return <Pill tone="accent">{t("we.yours")}</Pill>;
  return null;
}

function Card({ process: w }: { process: ProcessInfo }) {
  const data = useUi((s) => s.data);
  const uses = useMemo(() => usesOf(data, w.id), [data, w.id]);
  const running = uses.running.length;
  const broken = w.issues.length > 0;
  return (
    <div
      className={cx(
        "group relative flex h-full flex-col rounded-lg border bg-panel p-3.5 transition-colors hover:border-[color-mix(in_srgb,var(--accent)_40%,var(--line))]",
        broken ? "border-[color-mix(in_srgb,var(--danger)_45%,var(--line))]" : "border-line",
      )}
    >
      <div className="flex items-start gap-2">
        <ProcessIcon name={w.icon} size={15} className="mt-0.5 shrink-0 text-muted" />
        <button
          className="min-w-0 flex-1 text-left font-medium after:absolute after:inset-0 after:content-[''] focus-visible:outline-none"
          onClick={() => openProcess(w.id)}
        >
          {processText(w)}
        </button>
        <span className="relative z-10 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          <Menu>
            <MenuTrigger asChild>
              <IconButton icon={MoreHorizontal} label={processText(w)} />
            </MenuTrigger>
            <MenuContent align="end">
              <MenuItem onSelect={() => openProcess(w.id)}>{t("we.open")}</MenuItem>
              {cardMenuExtras(w)}
            </MenuContent>
          </Menu>
        </span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-faint">
        {originPill(w)}
        {!w.original && w.plugin !== "my-processes" && <span>{t("we.fromPlugin", { plugin: w.plugin })}</span>}
      </div>
      {w.description && <p className="mt-2 line-clamp-3 text-xs text-muted">{processText(w, "description")}</p>}
      {broken && (
        <div className="relative z-10 mt-2 flex items-start gap-1.5 text-xs text-[var(--danger)]">
          <CircleAlert size={13} className="mt-px shrink-0" />
          <span className="min-w-0 flex-1">
            {t("we.cannotRun")}: {issueText(w.issues[0], w, getState().data)}
          </span>
          <Button size="sm" variant="ghost" className="-my-1 h-6 px-1.5" onClick={() => openProcess(w.id, { fix: true })}>
            {t("we.fix")}
          </Button>
        </div>
      )}
      <div className="mt-auto pt-3 text-[11px] text-muted">
        <div>
          {stepsCount(w.nodes.length)} · <span className={cx(w.asks > 0 && "text-accent")}>{asksText(w.asks)}</span>
        </div>
        <div className="text-faint">
          {[...usesText(uses), running ? (running === 1 ? t("we.runningOne") : t("we.running", { n: running })) : ""].filter(Boolean).join(" · ") ||
            t("we.notUsed")}
        </div>
      </div>
    </div>
  );
}
