// Restarting the server without cutting agents off mid-answer: wait until none is busy, then restart.
// The sessions come back suspended and resume when opened.
import type { EventBus } from "./events.ts";
import type { Sessions } from "./sessions.ts";

/** How long no agent may be busy before the restart goes ahead, so a pause between two outputs does not count. */
export const QUIET_MS = 3000;

export class Restart {
  private events: EventBus;
  private sessions: Sessions;
  private restart: () => void;
  private timer: ReturnType<typeof setInterval> | undefined;
  private quietSince = 0;

  /** `restart` stops this server and starts it again; the app's entry point provides it. */
  constructor(events: EventBus, sessions: Sessions, restart: () => void) {
    this.events = events;
    this.sessions = sessions;
    this.restart = restart;
  }

  get pending(): boolean {
    return this.timer !== undefined;
  }

  /** Restarts once no agent has been busy for QUIET_MS. */
  request(): void {
    if (this.timer) return;
    this.quietSince = 0;
    this.timer = setInterval(() => this.check(), 250);
    this.events.emit("restart.changed", { pending: true });
    this.check();
  }

  cancel(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
    this.events.emit("restart.changed", { pending: false });
  }

  private check(): void {
    const now = Date.now();
    if (this.sessions.busy().length > 0) {
      this.quietSince = 0;
      return;
    }
    this.quietSince ||= now;
    if (now - this.quietSince < QUIET_MS) return;
    clearInterval(this.timer);
    this.timer = undefined;
    this.events.emit("restart.now", {});
    this.restart();
  }
}
