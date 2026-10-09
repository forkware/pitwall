import { Settings } from "lucide-react";
import { useUi } from "../api.ts";
import { t } from "../i18n.ts";
import { cx, IconButton } from "../kit/index.tsx";
import { openSettings } from "../sdk.tsx";
import { Slot } from "../slots.tsx";

export function TopBar() {
  const name = useUi((s) => s.data?.app.name ?? "pitwall");
  const open = useUi((s) => s.selection?.kind === "settings");
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-panel px-4">
      <div className="flex items-center gap-2.5">
        <Logo />
        <span className="text-[14px] font-semibold tracking-[-0.01em]">{name}</span>
      </div>
      <div className="ml-auto flex items-center gap-2">
        <Slot name="header.actions" />
        <IconButton
          icon={Settings}
          label={t("settings")}
          aria-pressed={open}
          className={cx("size-8", open && "bg-hover text-text")}
          onClick={openSettings}
        />
      </div>
    </header>
  );
}

function Logo() {
  return (
    <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden>
      <defs>
        <linearGradient id="logo" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--accent)" />
          <stop offset="1" stopColor="var(--accent-2)" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8" fill="url(#logo)" />
      <path d="M10 22l6-12 6 12" stroke="white" strokeWidth="3" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
