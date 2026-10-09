// Dates and names as the interface shows them.
import type { StatusDef } from "../sdk/types.ts";
import { lang, t } from "./i18n.ts";

const DAY = 24 * 60 * 60 * 1000;

const startOfDay = (at: number) => {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** "14:02" today, "Mon" this week, "8 Oct" this year, "8 Oct 2025" before. */
export function formatWhen(at: number, now = Date.now()): string {
  const today = startOfDay(now);
  if (at >= today && at < today + DAY) return new Date(at).toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" });
  if (at >= today - 6 * DAY && at < today) return new Date(at).toLocaleDateString(lang, { weekday: "short" });
  const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear();
  return new Date(at).toLocaleDateString(lang, { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) });
}

/** "8 Oct, 03:00". */
export function formatDateTime(at: number): string {
  return new Date(at).toLocaleString(lang, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** "15:24": the time of day, for things that happened today or so. */
export function formatTime(at: number): string {
  return new Date(at).toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" });
}

/** "today", "tomorrow", "in 3 d": how soon a moment comes. */
export function formatIn(at: number, now = Date.now()): string {
  const days = Math.round((startOfDay(at) - startOfDay(now)) / DAY);
  if (days <= 0) return t("today");
  if (days === 1) return t("tomorrow");
  return t("inDays", { n: days });
}

/** Days until a moment, rounded down; 0 for today or the past. */
export function daysUntil(at: number, now = Date.now()): number {
  return Math.max(0, Math.round((startOfDay(at) - startOfDay(now)) / DAY));
}

/** The group an archived task falls in by when it was archived. */
export function archiveGroup(at: number, now = Date.now()): string {
  const today = startOfDay(now);
  if (at >= today) return t("groupToday");
  if (at >= today - 6 * DAY) return t("groupWeek");
  const d = new Date(at);
  const n = new Date(now);
  if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth()) return t("groupMonth");
  const month = d.toLocaleDateString(lang, { month: "long", ...(d.getFullYear() === n.getFullYear() ? {} : { year: "numeric" }) });
  return month.charAt(0).toUpperCase() + month.slice(1);
}

/** A status's name in the interface's language. */
export function statusLabel(def: Pick<StatusDef, "id" | "label"> | undefined, fallback = ""): string {
  if (!def) return fallback;
  const key = `status.${def.id}`;
  const text = t(key);
  return text === key ? def.label : text;
}

/** Who archived a task, in words. */
export function archivedByLabel(by: string | null): string {
  if (!by) return "";
  if (by.startsWith("automation:")) return t("archivedBy.automation");
  const key = `archivedBy.${by}`;
  const text = t(key);
  return text === key ? t("archivedBy.plugin") : text;
}
