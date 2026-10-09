// Under a task's header: which automation made it, when and how, and what its webhook received.
import { ChevronRight, Repeat, Webhook } from "lucide-react";
import { useState } from "react";
import type { Task } from "../../sdk/types.ts";
import { useUi } from "../api.ts";
import { formatDateTime } from "../format.ts";
import { t } from "../i18n.ts";
import { cx } from "../kit/index.tsx";
import { selectAutomation } from "../sdk.tsx";

interface Origin {
  id: string;
  how: string;
  payload?: unknown;
}

export function AutomationOrigin({ task }: { task: Task }) {
  const origin = task.meta.automation as Origin | undefined;
  const automation = useUi((s) => s.data?.automations.find((a) => a.id === origin?.id));
  const [open, setOpen] = useState(false);
  if (!origin) return null;
  const Icon = origin.how === "webhook" ? Webhook : Repeat;
  return (
    <div className="shrink-0 border-b border-line px-5 py-1.5 text-xs text-muted">
      <div className="flex items-center gap-1.5">
        <Icon size={12} className="shrink-0 text-faint" />
        <span>{t("madeBy")}</span>
        {automation ? (
          <button className="font-medium text-text hover:underline" onClick={() => selectAutomation(automation.id)}>
            {automation.name}
          </button>
        ) : (
          <span className="text-faint">{t("automationGone")}</span>
        )}
        <span className="text-faint">
          · {formatDateTime(task.createdAt)} · {t(`how.${origin.how}`)}
        </span>
        {origin.payload !== undefined && (
          <button className="ml-2 inline-flex items-center gap-0.5 text-faint hover:text-text" onClick={() => setOpen(!open)}>
            <ChevronRight size={12} className={cx("transition-transform", open && "rotate-90")} />
            {t("payload")}
          </button>
        )}
      </div>
      {open && (
        <pre className="mt-1.5 max-h-60 overflow-auto rounded-md border border-line bg-bg p-2 font-mono text-[11px]">
          {JSON.stringify(origin.payload, null, 2)}
        </pre>
      )}
    </div>
  );
}
