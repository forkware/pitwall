import { MousePointerClick } from "lucide-react";
import { useEffect } from "react";
import { getState, onEvent, useUi } from "../api.ts";
import { t } from "../i18n.ts";
import { DialogHost, EmptyState, toast, Toaster } from "../kit/index.tsx";
import { openArchive, openAutomations, openSettings, selectAutomation, useSelectedFolder, useSelectedTask } from "../sdk.tsx";
import { installShortcuts } from "../slots.tsx";
import { ErrorBoundary } from "./ErrorBoundary.tsx";
import { RestartBanner } from "./Restart.tsx";
import { SettingsView } from "./Settings.tsx";
import { FolderPage } from "./FolderPage.tsx";
import { ArchivePage } from "./ArchiveView.tsx";
import { ArchivedTaskView } from "./ArchivedTaskView.tsx";
import { AutomationPage, AutomationsPage, openAutomationDialog } from "./AutomationsView.tsx";
import { PluginPage } from "../slots.tsx";
import { addCoreCommands } from "../commands.ts";
import { archiveTasks } from "../archiveActions.ts";
import { Sidebar } from "./Sidebar.tsx";
import { TaskView } from "./TaskView.tsx";
import { TopBar } from "./TopBar.tsx";

export function App() {
  const loaded = useUi((s) => s.data !== null);
  const connected = useUi((s) => s.connected);
  const selected = useUi((s) => (s.selection ? `${s.selection.kind}:${"id" in s.selection ? s.selection.id : ""}` : ""));

  // Rule 7: a plugin that writes without declaring the permission is reported.
  useEffect(() => onEvent((name, p) => name === "audit.alarm" && toast(t("alarm", p), "error")), []);
  // What the archive's rules did while nobody looked, and automations whose run failed.
  useEffect(
    () =>
      onEvent((name, p) => {
        if (name === "archive.swept") {
          const parts = [p.archived ? t("sweptArchived", { n: p.archived }) : "", p.deleted ? t("sweptDeleted", { n: p.deleted }) : ""];
          toast(parts.filter(Boolean).join(". "), "info", { action: { label: t("details"), run: () => openArchive() } });
        }
        if (name === "automation.run" && p.result === "error") {
          const a = getState().data?.automations.find((x) => x.id === p.automationId);
          toast(t("automationFailed", { name: a?.name ?? "" }), "error", { action: { label: t("open"), run: () => selectAutomation(p.automationId) } });
        }
      }),
    [],
  );
  useEffect(installShortcuts, []);

  return (
    <div className="flex h-full flex-col">
      <TopBar />
      {!connected && loaded && (
        <div className="border-b border-line bg-[color-mix(in_srgb,var(--s-amber)_12%,transparent)] px-4 py-1.5 text-xs text-muted">
          {t("disconnected")}
        </div>
      )}
      <RestartBanner />
      {loaded && (
        <div className="flex min-h-0 flex-1">
          <ErrorBoundary>
            <Sidebar />
          </ErrorBoundary>
          <main className="min-w-0 flex-1">
            <ErrorBoundary resetKey={selected}>
              <Main />
            </ErrorBoundary>
          </main>
        </div>
      )}
      <DialogHost />
      <Toaster />
    </div>
  );
}

/** What is selected: a task, a folder or the settings. */
function Main() {
  const settings = useUi((s) => s.selection?.kind === "settings");
  const task = useSelectedTask();
  const folder = useSelectedFolder();
  const selection = useUi((s) => s.selection);
  if (task) return <TaskView key={task.id} task={task} />;
  if (folder) return <FolderPage key={folder.id} folder={folder} />;
  if (settings) return <SettingsView />;
  switch (selection?.kind) {
    case "archive":
      return <ArchivePage key={selection.folderId ?? ""} folderId={selection.folderId} />;
    case "archived":
      return <ArchivedTaskView key={selection.id} id={selection.id} />;
    case "automations":
      return <AutomationsPage />;
    case "automation":
      return <AutomationPage key={selection.id} id={selection.id} />;
    case "page":
      return <PluginPage key={`${selection.plugin}.${selection.page}`} plugin={selection.plugin} page={selection.page} params={selection.params} />;
  }
  return <EmptyState icon={MousePointerClick} title={t("noSelectionTitle")} body={t("noSelectionBody")} />;
}

addCoreCommands([
  { id: "core.openArchive", label: t("cmd.openArchive"), keywords: ["archive", "архив"], run: () => openArchive() },
  { id: "core.openAutomations", label: t("cmd.openAutomations"), keywords: ["cron", "webhook", "крон", "вебхук"], run: openAutomations },
  { id: "core.settings", label: t("cmd.settings"), run: openSettings },
  { id: "core.archiveTask", label: t("cmd.archiveTask"), scope: "task", run: (task) => archiveTasks([task]) },
  { id: "core.newAutomation", label: t("cmd.newAutomation"), scope: "folder", run: (folder) => openAutomationDialog(folder) },
]);
