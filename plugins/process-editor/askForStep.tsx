// "Ask an agent to make the step": a step that needs code is an ordinary customization of the app (issue, plugin,
// tests), started from where the user noticed it is missing.
import { useState } from "react";
import { Button, Dialog, refresh, rpc, selectTask, showCustomDialog, t, TextArea, toast } from "#sdk/ui";
import { fieldClass } from "./EditCard.tsx";

/** What the customization agent is asked: a step plugin that describes itself for the editor. */
export function stepRequest(description: string, process?: string): string {
  return [
    `Make a new step for the app's processes (processes): ${description}`,
    "Make it a step in a plugin (`ctx.steps.register`, see \"Processes\" in CLAUDE.md) that describes itself for the process editor: label, description, icon, group, role, params with defaults (a setting's value where the user would set one), outcomes it can branch on, questions it asks, sideEffects when it changes anything outside the app.",
    "Give it words in English and Russian with addStrings (`step:<id>`, `param:<step>:<key>`, `outcome:<key>:<value>`).",
    process ? `The user wants it in the process ${process}; do not change that process yourself, the user puts the step in it from the editor.` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function askForStep(description: string, process?: string, onStarted?: (taskId: string) => void): void {
  showCustomDialog(({ open, onOpenChange }) => (
    <AskForStepDialog description={description} process={process} onStarted={onStarted} open={open} onOpenChange={onOpenChange} />
  ));
}

function AskForStepDialog({
  description,
  process,
  onStarted,
  open,
  onOpenChange,
}: {
  description: string;
  process?: string;
  onStarted?: (taskId: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [text, setText] = useState(description);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onOpenChange={onOpenChange} wide title={t("we.askStep.title")} description={t("we.askStep.body")}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!text.trim()) return;
          setBusy(true);
          try {
            const { taskId } = await rpc<{ taskId: string }>("customize-app", "start", { title: t("we.askStep.task"), request: stepRequest(text.trim(), process) });
            onOpenChange(false);
            onStarted?.(taskId);
            toast(t("we.askStep.started"), "info", { action: { label: t("we.open"), run: () => void refresh().then(() => selectTask(taskId)) } });
          } catch (error) {
            toast((error as Error).message, "error");
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="block">
          <span className="mb-1 block text-xs text-muted">{t("we.askStep.what")}</span>
          <TextArea autoFocus rows={4} className={fieldClass} value={text} onChange={(e) => setText(e.target.value)} />
        </label>
        <p className="mt-2 text-xs text-faint">{t("we.askStep.restart")}</p>
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            {t("cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={busy || !text.trim()}>
            {t("we.askStep.start")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
