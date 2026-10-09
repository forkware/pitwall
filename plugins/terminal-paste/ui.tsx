import { addStrings, defineUiPlugin, t, toast, type TerminalHandle } from "#sdk/ui";

addStrings({
  en: { pasteUnavailable: "Paste is not available here: the browser does not give access to the clipboard" },
  ru: { pasteUnavailable: "Вставка здесь недоступна: браузер не даёт доступа к буферу обмена" },
});

/** Pastes the text selected in the terminal into the agent, or the clipboard's when nothing is selected. */
export async function pasteSelectionOrClipboard(term: TerminalHandle): Promise<void> {
  const selected = term.selection();
  if (!selected) return pasteClipboard(term);
  term.focus();
  term.paste(selected);
}

/** Pastes the clipboard's text into the agent. */
export async function pasteClipboard(term: TerminalHandle): Promise<void> {
  let text: string;
  try {
    // navigator.clipboard is missing outside secure contexts, e.g. the server opened by its network address.
    text = await navigator.clipboard.readText();
  } catch {
    toast(t("pasteUnavailable"), "error");
    return;
  }
  term.focus();
  if (text) term.paste(text);
}

export function terminal(term: TerminalHandle): () => void {
  const onContextMenu = (e: Event) => {
    e.preventDefault();
    // Before xterm sees it: xterm puts the selection into its input field, selected, for a context menu we do
    // not show; on Linux the input method could then type it into the agent a second time.
    e.stopPropagation();
    // An agent that tracks the mouse got the click from xterm and pastes by itself (Claude Code in full screen does
    // on Linux and Windows); pasting here too put the text in twice. Shift keeps the click from the agent.
    if (term.tracksMouse() && !(e as MouseEvent).shiftKey) return;
    void pasteSelectionOrClipboard(term);
  };
  term.element.addEventListener("contextmenu", onContextMenu, { capture: true });
  return () => term.element.removeEventListener("contextmenu", onContextMenu, { capture: true });
}

export default defineUiPlugin({ terminal });
