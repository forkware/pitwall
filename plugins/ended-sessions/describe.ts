// What the card over an ended agent says: string keys for t(), so the logic is tested without the UI.
import type { Continuation, Session } from "#sdk/server";

export interface Described {
  /** Why it ended. */
  title: string;
  vars?: Record<string, string | number>;
  /** What continuing does, or why it cannot. */
  detail: string;
  /** The main button, when there is one. */
  action?: string;
}

export function describeEnded(session: Pick<Session, "exitReason" | "exitCode">, c: Continuation): Described {
  const reason = session.exitReason;
  const title =
    reason === "stopped" || reason === "gone" || reason === "archived"
      ? `ended-sessions.${reason}`
      : reason
        ? reason // a plugin's own key, e.g. "dev-flow.merged"
        : session.exitCode === 0
          ? "ended-sessions.finished"
          : session.exitCode === null
            ? "ended-sessions.ended"
            : "ended-sessions.failed";
  const vars = session.exitCode !== null && session.exitCode !== 0 ? { code: session.exitCode } : undefined;
  if (!c.possible) return { title, vars, detail: c.gone ? "ended-sessions.cannotGone" : "ended-sessions.cannot" };
  if (c.gone && c.restore) return { title, vars, detail: c.restore, action: "ended-sessions.restoreAndContinue" };
  return c.resumes
    ? { title, vars, detail: "ended-sessions.resumes", action: "ended-sessions.continue" }
    : { title, vars, detail: "ended-sessions.afresh", action: "ended-sessions.startAgain" };
}
