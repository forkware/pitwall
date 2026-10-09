// Dialogs opened from code stack: one opened from a dialog (a directory picker from the new-folder dialog)
// shows on top of it, and closing it shows the one below again with what was typed there.

export interface DialogEntry<D> {
  id: number;
  dialog: D;
  open: boolean;
}

export function createDialogStack<D>() {
  let entries: DialogEntry<D>[] = [];
  let next = 1;
  const listeners = new Set<() => void>();
  const set = (value: DialogEntry<D>[]) => {
    entries = value;
    listeners.forEach((l) => l());
  };
  return {
    /** Shows `dialog` on top. Closed dialogs, kept so they can animate out, go now. */
    open(dialog: D): number {
      const id = next++;
      set([...entries.filter((e) => e.open), { id, dialog, open: true }]);
      return id;
    },
    /**
     * Closes this dialog only: one that opens the next dialog and then closes itself (a prompt whose
     * answer asks something else) leaves the next one open.
     */
    close(id: number): void {
      if (!entries.some((e) => e.id === id && e.open)) return;
      set(entries.map((e) => (e.id === id ? { ...e, open: false } : e)));
    },
    entries: () => entries,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
