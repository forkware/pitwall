// Keeps the terminals of recently opened sessions alive, so going back to a task shows its output at once
// instead of replaying it. Terminals on screen are never evicted; of the others, the least recently used go first.

export class TerminalPool<T> {
  /** Session id → entry, least recently used first. */
  private entries = new Map<string, { value: T; refs: number }>();
  private create: (id: string) => T;
  private dispose: (value: T) => void;
  private limit: () => number;

  constructor(create: (id: string) => T, dispose: (value: T) => void, limit: () => number) {
    this.create = create;
    this.dispose = dispose;
    this.limit = limit;
  }

  /** The session's terminal, created if needed, marked as on screen until release(). */
  acquire(id: string): T {
    const entry = this.entries.get(id) ?? { value: this.create(id), refs: 0 };
    entry.refs++;
    this.entries.delete(id);
    this.entries.set(id, entry);
    this.evict();
    return entry.value;
  }

  /** The terminal left the screen; it stays in the pool while there is room. */
  release(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.refs = Math.max(0, entry.refs - 1);
    this.evict();
  }

  /** Disposes the session's terminal now, e.g. when the session is removed. */
  remove(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    this.dispose(entry.value);
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  /** Session ids, least recently used first. */
  ids(): string[] {
    return [...this.entries.keys()];
  }

  private evict(): void {
    const limit = Math.max(1, Math.floor(this.limit()) || 1);
    for (const [id, entry] of this.entries) {
      if (this.entries.size <= limit) return;
      if (entry.refs === 0) this.remove(id);
    }
  }
}

/** Splits replayed output so the terminal parses it between frames instead of in one blocking go. */
export function chunks(data: string, size = 64 * 1024): string[] {
  if (data.length <= size) return [data];
  const parts: string[] = [];
  for (let i = 0; i < data.length; i += size) {
    let end = Math.min(i + size, data.length);
    // Do not split a surrogate pair.
    if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1])) end++;
    parts.push(data.slice(i, end));
    i = end - size;
  }
  return parts;
}
