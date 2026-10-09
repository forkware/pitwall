import { definePlugin } from "#sdk/server";
import { hasTranscript } from "./transcripts.ts";

/**
 * Out of its usage limit, Claude stops until it resets and goes on by itself:
 * "Usage limit reached · continuing automatically at 3:30pm", "You've hit your session limit · resets 3:30pm".
 * A bare "resets 3pm" is not enough: Claude shows it beside "Approaching usage limit" while it still works.
 */
export const waitsForLimit = (screen: string): boolean =>
  /Usage limit reached|You['’]ve hit your (?:\w+ )?limit|continuing automatically at/i.test(screen.slice(-1500));

export default definePlugin((ctx) => {
  ctx.agents.registerProvider({
    id: "claude-code",
    label: "Claude Code",
    command: "claude",
    // The app's session id becomes Claude's, so the conversation can be resumed after a restart.
    // A prompt as the last argument starts an interactive session with that message.
    args: ({ prompt, sessionId }) => ["--session-id", sessionId, ...(prompt ? [prompt] : [])],
    // Print mode: answers once and exits.
    exec: ({ prompt }) => ["-p", prompt],
    // Its permission prompts: "Do you want to proceed?" over a "1. Yes / 2. No" menu.
    asks: (screen) => /Do you want to [a-z]|❯\s*1\.\s*Yes/i.test(screen.slice(-1500)),
    waits: waitsForLimit,
    resume: {
      // Sessions started before the app passed its id were given theirs by hand (agentSessionId).
      find: (session) => {
        const id = session.agentSessionId ?? session.id;
        return hasTranscript(id, session.cwd) ? id : undefined;
      },
      args: (id) => ["--resume", id],
    },
  });
});
