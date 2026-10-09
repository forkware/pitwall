// Places in the interface plugins add to, and their keyboard shortcuts. Each plugin's ui.tsx is found at build time.
import type { ComponentType } from "react";
import type { Folder, Session, Task, ProcessRun } from "../sdk/types.ts";
import { getState, useUi } from "./api.ts";
import { processShortcuts } from "./folderProcesses.ts";
import { findShortcut, isMac, setShortcutSource, type Shortcut, type ShortcutTarget } from "./shortcuts.ts";
import { createTask } from "./taskActions.ts";
import { addCoreCommands, setCommandSource } from "./commands.ts";
import { t } from "./i18n.ts";
import { openDetails, toggleDetails } from "./taskDetails.ts";
import { FileText, ListOrdered } from "lucide-react";
import { setFieldActions, type FieldHandle } from "./TextArea.tsx";

/** Slot name → props its components receive. */
export interface SlotProps {
  /** Top bar, right side. */
  "header.actions": {};
  /** Above the folder tree. */
  "sidebar.header": {};
  /** Above the folder tree, before Automations: items that open a page the user often goes to. */
  "sidebar.nav": {};
  /** Under the folder tree, with the Archive: items that open a page. */
  "sidebar.footer": {};
  /** Items in the menu a right click opens on the tree's empty space: render <MenuItem>s. */
  "tree.menu": {};
  /** After a folder's name. */
  "folder.badge": { folder: Folder };
  /** Items in a folder's menu: render <MenuItem>s. */
  "folder.menu": { folder: Folder };
  /** Sections on the folder's page, below its settings. */
  "folder.settings": { folder: Folder };
  /**
   * Fields in the new-folder dialog. `onCreate(step)` hands the dialog what to do when it is submitted
   * and returns the function that takes it back: call it in an effect that depends on the field's value.
   */
  "folder.create": { parentId: string | null; onCreate: (step: FolderCreateStep) => () => void };
  /** After a task's name in the tree. */
  "task.badge": { task: Task };
  /** Items in a task's menu: render <MenuItem>s. */
  "task.menu": { task: Task };
  /** In the task header, on the right, before the process's answers. */
  "task.header": { task: Task };
  /** In the task header, before the answers the process waits for: actions on the step (e.g. "Open the stand"). */
  "process.bar": { task: Task; run: ProcessRun };
  /** Under the question a task's process waits on: a hint about it. Render nothing when there is none. */
  "process.question": { task: Task; run: ProcessRun };
  /**
   * Under the task's header, above its agents: something the user must see now (a warning). Keep it rare;
   * what can wait goes in the details panel (task.details.*).
   */
  "task.panel": { task: Task };
  /** The details panel's Description tab, above the task's own text: e.g. a refined description. */
  "task.details.description": { task: Task };
  /** The details panel's Process tab, under the history: links about the process (its recipe, say). */
  "task.details.process": { task: Task; run: ProcessRun };
  /** The details panel's Environment tab, above the agents: where the task works (a worktree, a dev stand). */
  "task.details.environment": { task: Task };
  /** Above the agent terminal. */
  "session.toolbar": { task: Task; session: Session };
  /** Between the toolbar and the terminal of a session whose agent ended: what it means and what to do. */
  "session.ended": { task: Task; session: Session };
  /** In the corner of every multiline text field (<TextArea>): small buttons, e.g. <IconButton>. */
  "field.actions": { field: FieldHandle };
}

export type SlotName = keyof SlotProps;

/** What a plugin's field in the new-folder dialog does when the dialog is submitted. */
export interface FolderCreateStep {
  /** Before the folder is made: throw to keep the dialog open with the message. */
  check?: () => unknown | Promise<unknown>;
  /** After it is made: store the field's value in it. */
  created?: (folder: Folder) => unknown | Promise<unknown>;
}

/** One agent terminal, as plugins see it. */
export interface TerminalHandle {
  sessionId: string;
  /** The terminal's element: listen for mouse events here. */
  element: HTMLElement;
  /** Types text into the agent as a paste (bracketed when the agent asks for it). */
  paste(text: string): void;
  /** The text selected in the terminal, "" when nothing is. */
  selection(): string;
  focus(): void;
  /** True while the agent tracks the mouse (Claude Code in full screen): it gets the clicks and handles them itself. */
  tracksMouse(): boolean;
}

/** What a plugin's page in the main panel gets: `openPage(plugin, page, params)` opens it. */
export interface PageProps {
  params: Record<string, unknown>;
}

/**
 * An action the command palette (and anything else that lists commands) offers.
 * Scope "task" acts on the open task, "folder" on the open folder or the open task's folder.
 */
export type Command = {
  id: string;
  label: string;
  /** More words it is found by. */
  keywords?: string[];
  icon?: ComponentType<{ size?: number; className?: string }>;
} & (
  | { scope?: "global"; run: () => void }
  | { scope: "task"; run: (task: Task) => void }
  | { scope: "folder"; run: (folder: Folder) => void }
);

export interface UiPlugin {
  slots?: { [K in SlotName]?: ComponentType<SlotProps[K]> | ComponentType<SlotProps[K]>[] };
  /** Pages of the main panel, by name: `openPage("<plugin id>", "<name>", params)`. */
  pages?: Record<string, ComponentType<PageProps>>;
  /** Actions for the command palette. */
  commands?: Command[];
  /** Checked in plugin order; the first that fits the key and the target runs. */
  shortcuts?: Shortcut[];
  /** Called for each agent terminal when it opens; the function it returns runs when the terminal closes. */
  terminal?: (term: TerminalHandle) => void | (() => void);
}

const modules = import.meta.glob<{ default: UiPlugin }>("../../plugins/*/ui.tsx", { eager: true });

const plugins = Object.entries(modules).map(([path, mod]) => ({
  id: path.split("/").at(-2)!,
  plugin: mod.default,
}));

/** Whether an enabled plugin contributes to a slot: a menu with nothing in it is not opened. */
export function useSlotFilled(name: SlotName): boolean {
  const enabled = useUi((s) => s.data?.plugins);
  return plugins.some(({ id, plugin }) => enabled?.some((p) => p.id === id) && !!plugin.slots?.[name]);
}

/** Renders what enabled plugins contributed to a slot. */
export function Slot<K extends SlotName>({ name, ...props }: { name: K } & SlotProps[K]) {
  const enabled = useUi((s) => s.data?.plugins);
  return (
    <>
      {plugins
        .filter(({ id }) => enabled?.some((p) => p.id === id))
        .flatMap(({ id, plugin }) => {
          const contributed: unknown = plugin.slots?.[name];
          const components = (Array.isArray(contributed) ? contributed : contributed ? [contributed] : []) as ComponentType<
            SlotProps[K]
          >[];
          return components.map((Component, i) => <Component key={`${id}-${i}`} {...(props as unknown as SlotProps[K])} />);
        })}
    </>
  );
}

setFieldActions((field) => <Slot name="field.actions" field={field} />);

/** A plugin's page, or nothing when the plugin is off or has no such page. */
export function PluginPage({ plugin, page, params }: { plugin: string; page: string; params?: Record<string, unknown> }) {
  const enabled = useUi((s) => s.data?.plugins.some((p) => p.id === plugin));
  const Page = enabled ? plugins.find((p) => p.id === plugin)?.plugin.pages?.[page] : undefined;
  return Page ? <Page params={params ?? {}} /> : null;
}

setCommandSource(() => {
  const enabled = getState().data?.plugins ?? [];
  return plugins.filter(({ id }) => enabled.some((p) => p.id === id)).flatMap(({ plugin }) => plugin.commands ?? []);
});

/** Hands a new terminal to enabled plugins. Returns the function that undoes what they did. */
export function attachTerminalPlugins(term: TerminalHandle): () => void {
  const enabled = getState().data?.plugins ?? [];
  const cleanups = plugins
    .filter(({ id }) => enabled.some((p) => p.id === id))
    .map(({ plugin }) => plugin.terminal?.(term));
  return () => cleanups.forEach((cleanup) => cleanup?.());
}

/** The core's own keys: the task's details panel, from anywhere on its page, the terminal included. */
const coreShortcuts: Shortcut[] = [
  { command: "details.description", keys: "Alt+Shift+D", scope: "task", inInputs: true, run: () => toggleDetails("description") },
  { command: "details.process", keys: "Alt+Shift+P", scope: "task", inInputs: true, run: () => toggleDetails("process") },
];

addCoreCommands([
  { id: "details.description", label: t("cmd.detailsDescription"), scope: "task", icon: FileText, run: () => openDetails("description") },
  { id: "details.process", label: t("cmd.detailsProcess"), scope: "task", icon: ListOrdered, run: () => openDetails("process") },
]);

function enabledShortcuts(): Shortcut[] {
  const enabled = getState().data?.plugins ?? [];
  return [...plugins.filter(({ id }) => enabled.some((p) => p.id === id)).flatMap(({ plugin }) => plugin.shortcuts ?? []), ...coreShortcuts];
}
setShortcutSource(enabledShortcuts);

/** Listens for shortcuts of enabled plugins. Returns the function that stops it. */
export function installShortcuts(): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.isComposing) return;
    const focused = document.activeElement;
    // Open menus and dialogs handle their own keys.
    if (focused?.closest('[role="dialog"], [role="menu"]')) return;
    const inInput = !!focused?.closest("input, textarea, select, [contenteditable=''], [contenteditable='true'], .xterm");
    const target = shortcutTarget(focused);
    // Plugins' keys first; then the process hotkeys of the folder in focus or of the task in focus.
    const folderId = target.kind === "folder" ? target.folder.id : target.kind === "task" ? target.task.folderId : null;
    const shortcuts = [...enabledShortcuts(), ...processShortcuts(getState().data, folderId, (f, w) => void createTask(f, w))];
    const run = findShortcut(shortcuts, e, target, { mac: isMac, inInput });
    if (!run) return;
    e.preventDefault();
    run();
  };
  window.addEventListener("keydown", onKeyDown);
  return () => window.removeEventListener("keydown", onKeyDown);
}

/** The tree row in focus; with nothing in focus, the open task or folder. */
function shortcutTarget(focused: Element | null): ShortcutTarget {
  const { data, selection } = getState();
  const open = selection && (selection.kind === "task" || selection.kind === "folder") ? selection.id : null;
  const row = focused?.closest<HTMLElement>("[data-tree-id]");
  const id = row ? row.dataset.treeId : !focused || focused === document.body ? open : null;
  const task = data?.tasks.find((t) => t.id === id);
  if (task) return { kind: "task", task };
  const folder = data?.folders.find((f) => f.id === id);
  if (folder) return { kind: "folder", folder };
  return { kind: "none" };
}
