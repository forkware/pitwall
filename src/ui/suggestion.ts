// A field's likely answer: greyed in the empty field (or its options marked), Tab takes it.
import type { FormValue } from "../sdk/types.ts";

export const isEmpty = (value: FormValue | undefined): boolean =>
  Array.isArray(value) ? !value.some((v) => v.trim()) : !value?.trim();

/** The suggestion to show: only while the field is empty, so typing or picking hides it. */
export function shownSuggestion(value: FormValue | undefined, suggestion: FormValue | undefined): FormValue | undefined {
  if (!isEmpty(value) || isEmpty(suggestion)) return undefined;
  return Array.isArray(suggestion) ? suggestion.filter((s) => s.trim()) : suggestion!.trim();
}

/** The field's new value when this key takes the suggestion, else undefined (the key does what it does). */
export function takeSuggestion(
  key: { key: string; shiftKey?: boolean; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean },
  value: FormValue | undefined,
  suggestion: FormValue | undefined,
): FormValue | undefined {
  if (key.key !== "Tab" || key.shiftKey || key.ctrlKey || key.altKey || key.metaKey) return undefined;
  return shownSuggestion(value, suggestion);
}

/** A choice field's value split into the options picked and the user's own text ("Other…"). */
export function splitChoice(value: FormValue | undefined, options: string[]): { picked: string[]; other?: string } {
  const all = (Array.isArray(value) ? value : value ? [value] : []).filter((v) => v.trim());
  return { picked: options.filter((o) => all.includes(o)), other: all.find((v) => !options.includes(v)) };
}

/** The value a choice field sends: one string, or the list for `multiple`; the user's own text last. */
export function joinChoice(picked: string[], other: string | undefined, multiple?: boolean): FormValue {
  const all = other?.trim() ? [...picked, other.trim()] : picked;
  return multiple ? all : (all[0] ?? "");
}

/** Where an arrow key moves the focus among a choice's `count` options (wrapping), or undefined for other keys. */
export function arrowMove(key: string, index: number, count: number): number | undefined {
  if (!count) return undefined;
  if (key === "ArrowRight" || key === "ArrowDown") return (index + 1) % count;
  if (key === "ArrowLeft" || key === "ArrowUp") return (index - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return undefined;
}
