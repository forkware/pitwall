export type Handler = (payload: any) => void;
export type AnyHandler = (name: string, payload: unknown) => void;

/** Synchronous event bus. A failing handler is logged and does not stop the others. */
export class EventBus {
  private handlers = new Map<string, Set<Handler>>();
  private anyHandlers = new Set<AnyHandler>();

  on(name: string, handler: Handler): () => void {
    let set = this.handlers.get(name);
    if (!set) this.handlers.set(name, (set = new Set()));
    set.add(handler);
    return () => set.delete(handler);
  }

  /** Every event, for broadcasting to the UI. */
  onAny(handler: AnyHandler): () => void {
    this.anyHandlers.add(handler);
    return () => this.anyHandlers.delete(handler);
  }

  emit(name: string, payload?: unknown): void {
    for (const handler of this.handlers.get(name) ?? []) safely(name, () => handler(payload));
    for (const handler of this.anyHandlers) safely(name, () => handler(name, payload));
  }
}

function safely(name: string, run: () => void): void {
  try {
    run();
  } catch (error) {
    console.error(`Handler for ${name} failed:`, error);
  }
}
