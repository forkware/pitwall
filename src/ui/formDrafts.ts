// What the user typed into a process question's form and has not sent yet, per task.
// Kept in the browser's storage, so leaving the task or reloading the page does not lose it.
// A draft belongs to one question (its stamp: the run's updatedAt); a new question starts empty.

export type Draft = Record<string, string | string[]>;

type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;

const prefix = "processFormDraft:";

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function loadDraft(taskId: string, stamp: number, store = storage()): Draft {
  try {
    const saved = JSON.parse(store?.getItem(prefix + taskId) ?? "null") as { stamp: number; values: Draft } | null;
    return saved?.stamp === stamp ? saved.values : {};
  } catch {
    return {};
  }
}

export function saveDraft(taskId: string, stamp: number, values: Draft, store = storage()): void {
  try {
    if (Object.values(values).some((v) => v.length)) store?.setItem(prefix + taskId, JSON.stringify({ stamp, values }));
    else store?.removeItem(prefix + taskId);
  } catch {}
}

export function clearDraft(taskId: string, store = storage()): void {
  try {
    store?.removeItem(prefix + taskId);
  } catch {}
}
