// "The original changed": a plugin's process the user has their own version of got a new version. What changed in it,
// and "Take it into my version", which an agent does as any change in words.
import { Button, rpc, t, toast, type ProcessInfo, type ProcessVersion } from "#sdk/ui";
import { openDiff } from "./DiffRecipe.tsx";
import { openProcess } from "./Catalog.tsx";

export async function showOriginalUpdate(def: ProcessInfo): Promise<void> {
  if (!def.original) return;
  const versions = await rpc<ProcessVersion[]>("process-editor", "versions", { id: def.id }).catch(() => [] as ProcessVersion[]);
  const base = versions.find((v) => v.version === def.spec.base);
  if (!base) {
    toast(t("we.update.noBase"), "error");
    return;
  }
  const original = def.original;
  openDiff({
    title: t("we.update.title"),
    description: t("we.update.body", { plugin: original.plugin }),
    before: base.spec,
    after: original.spec,
    info: def,
    actions: (close) => (
      <Button
        variant="ghost"
        onClick={() => {
          close();
          openProcess(def.id, {
            change: Date.now(),
            rebase: true,
            request: t("we.update.request", {
              plugin: original.plugin,
              before: JSON.stringify({ nodes: base.spec.nodes, edges: base.spec.edges }),
              after: JSON.stringify({ nodes: original.spec.nodes, edges: original.spec.edges }),
            }),
          });
        }}
      >
        {t("we.update.take")}
      </Button>
    ),
  });
}
