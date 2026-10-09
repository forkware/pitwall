// Where Claude Code keeps a conversation, so a session the app's restart cut off can be resumed.
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Claude Code's data directory: CLAUDE_CONFIG_DIR, or ~/.claude. */
export function claudeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

/**
 * Whether Claude Code has a transcript for this session id: then `claude --resume <id>` continues it.
 * There is none until the first message. Transcripts live in projects/<cwd with every non-alphanumeric
 * character as "-">/<id>.jsonl; other project directories are searched too, as long paths are shortened.
 */
export function hasTranscript(id: string, cwd: string, dir = claudeDir()): boolean {
  const projects = join(dir, "projects");
  if (existsSync(join(projects, cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${id}.jsonl`))) return true;
  if (!existsSync(projects)) return false;
  return readdirSync(projects).some((name) => existsSync(join(projects, name, `${id}.jsonl`)));
}
