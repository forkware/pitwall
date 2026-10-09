import { Sparkles } from "lucide-react";
import { useState } from "react";
import { addStrings, attempt, Button, defineUiPlugin, refresh, rpc, selectTask, t } from "#sdk/ui";

addStrings({
  en: {
    "customize-app.button": "Customize the app",
    "customize-app.hint": "Tell an agent what to change in this app",
    "customize-app.task": "Customization",
  },
  ru: {
    "customize-app.button": "Настроить приложение",
    "customize-app.hint": "Скажите агенту, что изменить в этом приложении",
    "customize-app.task": "Настройка",
  },
});

function CustomizeButton() {
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true);
    const result = await attempt(() => rpc<{ taskId: string }>("customize-app", "start", { title: t("customize-app.task") }));
    setBusy(false);
    if (!result) return;
    await refresh();
    selectTask(result.taskId);
  };
  return (
    <Button variant="glow" icon={Sparkles} disabled={busy} title={t("customize-app.hint")} onClick={start}>
      {t("customize-app.button")}
    </Button>
  );
}

export default defineUiPlugin({
  slots: { "header.actions": CustomizeButton },
});
