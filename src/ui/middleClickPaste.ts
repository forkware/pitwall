// On Linux a middle click pastes the primary selection into the focused field: in a terminal, xterm's hidden
// input, which types it into the agent. An agent that tracks the mouse (Claude Code in full screen) gets the
// click from xterm too and pastes the selection itself, so it came out twice. As in other terminals, a click
// while the agent tracks the mouse is the agent's; with Shift held it is the terminal's (xterm does not send it).

/** How long after a middle click a paste is taken to be the browser's paste of that click. */
const pasteWindowMs = 500;

/** Keeps the browser's middle-click paste from an agent that handles the click itself. Returns the function that stops it. */
export function guardMiddleClickPaste(
  element: EventTarget,
  tracksMouse: () => boolean,
  now: () => number = () => performance.now(),
): () => void {
  let blockUntil = -Infinity;
  const onMouseUp = (e: Event) => {
    const { button, shiftKey } = e as MouseEvent;
    if (button !== 1 || shiftKey || !tracksMouse()) return;
    // Chromium pastes the selection after a mouseup nobody prevented.
    e.preventDefault();
    blockUntil = now() + pasteWindowMs;
  };
  const onPaste = (e: Event) => {
    if (now() > blockUntil) return;
    blockUntil = -Infinity;
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  element.addEventListener("mouseup", onMouseUp, { capture: true });
  element.addEventListener("paste", onPaste, { capture: true });
  return () => {
    element.removeEventListener("mouseup", onMouseUp, { capture: true });
    element.removeEventListener("paste", onPaste, { capture: true });
  };
}
