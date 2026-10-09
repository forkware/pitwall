// Cron expressions of five fields (minute hour day-of-month month day-of-week) in a time zone.
// "*", "5", "1-5", "*/15", "1-30/2", lists "1,15", names "mon-fri", "jan"; 7 is Sunday too.

export interface Cron {
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  /** Day of month and day of week both restricted: either one matches, as in cron. */
  either: boolean;
}

const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const weekdays = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const fields: { name: string; min: number; max: number; names?: string[]; offset?: number }[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: months, offset: 1 },
  { name: "day of week", min: 0, max: 7, names: weekdays, offset: 0 },
];

/** Parses an expression; throws an Error that says which field is wrong. */
export function parseCron(expression: string): Cron {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("A cron expression has five fields: minute hour day month weekday");
  const sets = parts.map((part, i) => parseField(part, fields[i]));
  sets[4] = new Set([...sets[4]].map((d) => (d === 7 ? 0 : d)));
  return {
    minutes: sets[0],
    hours: sets[1],
    days: sets[2],
    months: sets[3],
    weekdays: sets[4],
    either: parts[2] !== "*" && parts[4] !== "*",
  };
}

function parseField(text: string, field: (typeof fields)[number]): Set<number> {
  const out = new Set<number>();
  const value = (token: string): number => {
    const named = field.names?.indexOf(token.toLowerCase()) ?? -1;
    const n = named >= 0 ? named + (field.offset ?? 0) : /^\d+$/.test(token) ? Number(token) : NaN;
    if (!Number.isInteger(n) || n < field.min || n > field.max) {
      throw new Error(`${field.name}: "${token}" is not between ${field.min} and ${field.max}`);
    }
    return n;
  };
  for (const item of text.split(",")) {
    const [range, stepText] = item.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error(`${field.name}: "${item}" has a bad step`);
    let from: number;
    let to: number;
    if (range === "*") [from, to] = [field.min, field.max];
    else if (range.includes("-")) {
      const [a, b] = range.split("-");
      [from, to] = [value(a), value(b)];
      if (from > to) throw new Error(`${field.name}: "${range}" goes backwards`);
    } else {
      from = value(range);
      to = stepText === undefined ? from : field.max;
    }
    for (let n = from; n <= to; n += step) out.add(n);
  }
  return out;
}

/** Throws when the time zone is unknown. */
export function checkTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    throw new Error(`Unknown time zone ${timezone}`);
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** The wall clock in a time zone at a moment. */
export function wallClock(at: number, timezone: string) {
  let format = formatters.get(timezone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
    });
    formatters.set(timezone, format);
  }
  const parts: Record<string, string> = {};
  for (const p of format.formatToParts(at)) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday: weekdays.indexOf(parts.weekday.toLowerCase()),
  };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The first moment after `after` the expression fires, or null within a year (Feb 30th, say). */
export function nextRun(cron: Cron, after: number, timezone: string): number | null {
  let t = Math.floor(after / MINUTE) * MINUTE + MINUTE;
  for (let i = 0; i < 366 * 24 + 48; i++) {
    const w = wallClock(t, timezone);
    const dayOk = cron.either
      ? cron.days.has(w.day) || cron.weekdays.has(w.weekday)
      : cron.days.has(w.day) && cron.weekdays.has(w.weekday);
    if (cron.months.has(w.month) && dayOk && cron.hours.has(w.hour)) {
      for (let m = w.minute; m < 60; m++) {
        if (!cron.minutes.has(m)) continue;
        const candidate = t + (m - w.minute) * MINUTE;
        if (wallClock(candidate, timezone).hour === w.hour) return candidate;
        break;
      }
    }
    t = t - w.minute * MINUTE + HOUR; // the next hour on the wall clock
  }
  return null;
}

/** The next `count` runs after a moment. */
export function nextRuns(cron: Cron, after: number, timezone: string, count: number): number[] {
  const out: number[] = [];
  for (let at = after; out.length < count; ) {
    const next = nextRun(cron, at, timezone);
    if (next === null) break;
    out.push(next);
    at = next;
  }
  return out;
}
