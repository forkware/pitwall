# Right-click paste

## Intent

Right-clicking in an agent's terminal pastes the text from the clipboard, as in most terminals (issue #4). With text selected in the terminal, right-click pastes that text, exactly once (issue #39: it used to come out twice). A click on an agent that handles clicks itself pastes once too (issue #46).

## Spec

- Right-click with text selected in the terminal: the selection goes to the agent as a paste, once per click; the clipboard is not read. The handler runs in the capture phase and stops the event, so xterm does not put the selection into its hidden input field for a context menu: on Linux (Wayland, ibus) the input method could type it from there into the agent a second time.
- Right-click without a selection: the clipboard's text goes to the agent as a paste (bracketed when the agent asks for it, so multi-line text is not run line by line). The browser's context menu does not open.
- While the agent tracks the mouse (Claude Code in full screen), right-click is the agent's: xterm sends it the click and Claude Code pastes the clipboard itself, so the plugin only keeps the context menu away and pastes nothing. Shift+right-click is the terminal's (xterm does not send it to the agent) and pastes as above.
- An empty clipboard pastes nothing.
- When the clipboard cannot be read (the server opened by a network address over plain HTTP, or access denied), a toast says so and nothing is pasted.

The core part: `UiPlugin.terminal` (`src/ui/slots.tsx`): called with `{ sessionId, element, paste, selection, focus, tracksMouse }` for each agent terminal when it opens; the function it returns runs when the terminal closes.

## Check

`pnpm test` runs `tests/terminal-paste.test.ts`: right-click pastes and blocks the menu, a selection is pasted once per click and keeps the event from xterm, an empty clipboard does nothing, an unreadable clipboard shows a toast, the listener goes away with the terminal, an agent that tracks the mouse gets no second paste and Shift+right-click still pastes. The core's middle-click guard (`src/ui/middleClickPaste.ts`, `test/middleClickPaste.test.ts`) keeps the browser's primary-selection paste from such an agent. By hand: select text in an agent terminal and right-click several times, in the desktop window and in a browser: each click pastes it once. Copy some text, right-click in an agent terminal, the text appears in the agent's input. With Claude Code: copy `hello`, right-click and middle-click its terminal: `hello` comes once each time; Ctrl+Shift+V pastes it once.
