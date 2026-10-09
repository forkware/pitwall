// The frame of the editor's pages, as the core's pages look: a header with a title and tabs, then the content.
import type { ReactNode } from "react";
import { cx } from "#sdk/ui";

export function Page({
  icon,
  title,
  subtitle,
  tabs,
  actions,
  children,
  scroll = true,
}: {
  icon: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  tabs?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  scroll?: boolean;
}) {
  return (
    <section className="flex h-full min-w-0 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-5">
        {icon}
        <div className="min-w-0">
          {subtitle && <div className="truncate text-[11px] text-faint">{subtitle}</div>}
          <h1 className="truncate text-[15px] font-semibold leading-tight">{title}</h1>
        </div>
        {tabs}
        {actions && <div className="ml-auto flex shrink-0 items-center gap-1.5">{actions}</div>}
      </header>
      <div className={cx("flex min-h-0 flex-1 flex-col", scroll && "overflow-y-auto")}>{children}</div>
    </section>
  );
}

export function Tabs<T extends string>({ value, tabs, onChange }: { value: T; tabs: [T, string][]; onChange: (tab: T) => void }) {
  return (
    <nav role="tablist" className="ml-2 flex h-full min-w-0 items-end gap-1 overflow-x-auto sm:ml-4">
      {tabs.map(([id, label]) => (
        <button
          key={id}
          role="tab"
          aria-selected={value === id}
          onClick={() => onChange(id)}
          className={cx("relative h-10 px-3 text-[13px] font-medium transition-colors", value === id ? "text-text" : "text-muted hover:text-text")}
        >
          {label}
          {value === id && <span className="absolute inset-x-2 bottom-0 h-[2px] rounded-full bg-accent" />}
        </button>
      ))}
    </nav>
  );
}

/** A small rounded label: "changed by you", "Template". */
export function Pill({ children, tone }: { children: ReactNode; tone?: "accent" | "danger" | "muted" }) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 rounded px-1.5 py-px text-[11px]",
        tone === "accent" && "bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] text-accent",
        tone === "danger" && "bg-[color-mix(in_srgb,var(--danger)_12%,transparent)] text-[var(--danger)]",
        (!tone || tone === "muted") && "bg-raised text-muted",
      )}
    >
      {children}
    </span>
  );
}
