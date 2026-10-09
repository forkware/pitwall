import { definePlugin } from "#sdk/server";
import { findRollout } from "./rollouts.ts";

export default definePlugin((ctx) => {
  ctx.agents.registerProvider({
    id: "codex",
    label: "Codex",
    command: "codex",
    // A prompt as the first argument starts an interactive session with that message.
    args: ({ prompt }) => (prompt ? [prompt] : []),
    // Non-interactive: its last message goes to the file.
    exec: ({ prompt, outputFile }) => ["exec", "--skip-git-repo-check", "-o", outputFile, prompt],
    // Its approval prompts: "Would you like to run the following command?" with "Yes, proceed".
    asks: (screen) => /Would you like to [a-z]|Yes, proceed|Allow command\?/i.test(screen.slice(-1500)),
    resume: {
      find: (session, taken) => findRollout(session.cwd, session.startedAt, taken),
      args: (id) => ["resume", id],
    },
  });
});
