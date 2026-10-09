// Commands for the palette: the core's own and those of enabled plugins (slots.tsx hands them over).
import type { Command } from "./slots.tsx";

const core: Command[] = [];
let fromPlugins: () => Command[] = () => [];

export function setCommandSource(source: () => Command[]): void {
  fromPlugins = source;
}

/** The core's own commands, registered by the components that own them. */
export function addCoreCommands(commands: Command[]): void {
  for (const c of commands) if (!core.some((x) => x.id === c.id)) core.push(c);
}

/** Commands of the core and of enabled plugins; a command for a task or a folder needs one open. */
export function allCommands(): Command[] {
  return [...core, ...fromPlugins()];
}
