import { FolderInput, FolderSearch, HardDrive } from "lucide-react";
import { useEffect, useId, useState } from "react";
import {
  addStrings,
  Badge,
  Button,
  defineUiPlugin,
  getState,
  IconButton,
  Input,
  MenuItem,
  rpc,
  Section,
  t,
  useUi,
  type Folder,
  type SlotProps,
} from "#sdk/ui";
import { bound, boundFrom, newFolderPath, pathToBind } from "./binding.ts";
import { pickDirectory } from "./picker.tsx";

addStrings({
  en: {
    "local-dir.bind": "Bind a directory…",
    "local-dir.title": "Directory for “{name}”",
    "local-dir.body": "Agents for tasks in this folder and its subfolders start there.",
    "local-dir.unbind": "Unbind",
    "local-dir.section": "Directory",
    "local-dir.own": "Agents for tasks here start in this directory.",
    "local-dir.inherited": "Inherited from “{name}”.",
    "local-dir.none": "Not bound: agents start in a scratch directory.",
    "local-dir.change": "Change…",
    "local-dir.field": "Directory on disk",
    "local-dir.fieldHint": "Agents for its tasks start there. Empty: a scratch directory.",
    "local-dir.browse": "Choose a directory",
  },
  ru: {
    "local-dir.bind": "Привязать каталог…",
    "local-dir.title": "Каталог для «{name}»",
    "local-dir.body": "Агенты задач этой папки и её подпапок запускаются в нём.",
    "local-dir.unbind": "Отвязать",
    "local-dir.section": "Каталог",
    "local-dir.own": "Агенты задач этой папки запускаются в этом каталоге.",
    "local-dir.inherited": "Унаследован от «{name}».",
    "local-dir.none": "Не привязан: агенты запускаются во временном каталоге.",
    "local-dir.change": "Изменить…",
    "local-dir.field": "Каталог на диске",
    "local-dir.fieldHint": "Агенты её задач запускаются в нём. Пусто: временный каталог.",
    "local-dir.browse": "Выбрать каталог",
  },
});

function PathBadge({ folder }: { folder: Folder }) {
  const path = bound(folder);
  if (!path) return null;
  return (
    <span title={path}>
      <Badge>
        <HardDrive size={10} />
        {path.split(/[/\\]/).filter(Boolean).at(-1) ?? path}
      </Badge>
    </span>
  );
}

const bind = (folder: Folder) =>
  pickDirectory({
    title: t("local-dir.title", { name: folder.name }),
    description: t("local-dir.body"),
    initial: bound(folder),
    clear: bound(folder) ? t("local-dir.unbind") : undefined,
    onSubmit: async (path) => void (await rpc("local-dir", "bind", { folderId: folder.id, path })),
  });

function BindItem({ folder }: { folder: Folder }) {
  return (
    <MenuItem icon={FolderInput} onSelect={() => bind(folder)}>
      {t("local-dir.bind")}
    </MenuItem>
  );
}

/** On the folder's page: its directory, or the one it inherits. */
function DirectorySection({ folder }: { folder: Folder }) {
  const from = useUi((s) => boundFrom(s.data?.folders ?? [], folder.id));
  const path = from && bound(from);
  return (
    <Section title={t("local-dir.section")}>
      <div className="flex items-center gap-4 px-4 py-3.5">
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-[12px]">{path ?? "—"}</div>
          <div className="mt-0.5 text-xs text-muted">
            {!from
              ? t("local-dir.none")
              : from.id === folder.id
                ? t("local-dir.own")
                : t("local-dir.inherited", { name: from.name })}
          </div>
        </div>
        <Button size="sm" icon={FolderInput} onClick={() => bind(folder)}>
          {t("local-dir.change")}
        </Button>
      </div>
    </Section>
  );
}

/** In the new-folder dialog: the directory, the home directory to start with (a subfolder: its parent's). */
function NewFolderField({ parentId, onCreate }: SlotProps["folder.create"]) {
  const id = useId();
  const [path, setPath] = useState(() => newFolderPath(getState().data?.folders ?? [], parentId));
  useEffect(() => {
    const target = () => pathToBind(getState().data?.folders ?? [], parentId, path);
    return onCreate({
      check: async () => {
        const dir = target();
        if (dir) await rpc("local-dir", "check", { path: dir });
      },
      created: async (folder) => {
        const dir = target();
        if (dir) await rpc("local-dir", "bind", { folderId: folder.id, path: dir });
      },
    });
  }, [path, parentId, onCreate]);
  const browse = () =>
    pickDirectory({
      title: t("local-dir.browse"),
      initial: path.trim() === "~" ? "" : path,
      onSubmit: (picked) => setPath(picked),
    });
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs text-muted">
        {t("local-dir.field")}
      </label>
      <div className="flex items-center gap-1.5">
        <Input id={id} className="font-mono" value={path} onChange={(e) => setPath(e.target.value)} placeholder="~" />
        <IconButton icon={FolderSearch} label={t("local-dir.browse")} onClick={browse} />
      </div>
      <p className="mt-1 text-[11px] text-faint">{t("local-dir.fieldHint")}</p>
    </div>
  );
}

export default defineUiPlugin({
  slots: {
    "folder.badge": PathBadge,
    "folder.menu": BindItem,
    "folder.settings": DirectorySection,
    "folder.create": NewFolderField,
  },
});
