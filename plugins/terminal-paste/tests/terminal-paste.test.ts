import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock("../../../src/ui/kit/index.tsx", async (original) => ({ ...(await original<object>()), toast }));

const { terminal } = await import("../ui.tsx");

function fakeTerminal(selection = "", tracksMouse = false) {
  return {
    tracksMouse: () => tracksMouse,
    sessionId: "s1",
    element: new EventTarget() as HTMLElement,
    paste: vi.fn(),
    selection: () => selection,
    focus: vi.fn(),
  };
}

function rightClick(element: EventTarget, shiftKey = false) {
  const event = Object.assign(new Event("contextmenu", { cancelable: true }), { shiftKey });
  element.dispatchEvent(event);
  return event;
}

const flush = () => new Promise((resolve) => setTimeout(resolve));

beforeEach(() => toast.mockReset());
afterEach(() => vi.unstubAllGlobals());

describe("terminal-paste", () => {
  it("right-click pastes the clipboard into the agent instead of opening the menu", async () => {
    vi.stubGlobal("navigator", { clipboard: { readText: async () => "pnpm test" } });
    const term = fakeTerminal();
    terminal(term);
    const event = rightClick(term.element);
    await flush();
    expect(event.defaultPrevented).toBe(true);
    expect(term.paste).toHaveBeenCalledWith("pnpm test");
    expect(term.focus).toHaveBeenCalled();
  });

  it("right-click with a selection pastes the selection once, every time", async () => {
    const readText = vi.fn(async () => "clipboard");
    vi.stubGlobal("navigator", { clipboard: { readText } });
    const term = fakeTerminal("selected text");
    terminal(term);
    for (let i = 0; i < 3; i++) rightClick(term.element);
    await flush();
    expect(term.paste.mock.calls).toEqual([["selected text"], ["selected text"], ["selected text"]]);
    expect(readText).not.toHaveBeenCalled();
  });

  it("keeps xterm from loading the selection into its input field, which could type it a second time", () => {
    vi.stubGlobal("navigator", { clipboard: { readText: async () => "" } });
    const term = fakeTerminal("selected text");
    terminal(term);
    expect(rightClick(term.element).cancelBubble).toBe(true);
  });

  it("leaves the click to an agent that tracks the mouse and pastes by itself: the text comes once (#46)", async () => {
    const readText = vi.fn(async () => "hello");
    vi.stubGlobal("navigator", { clipboard: { readText } });
    const term = fakeTerminal("", true);
    terminal(term);
    const event = rightClick(term.element);
    await flush();
    expect(event.defaultPrevented).toBe(true);
    expect(term.paste).not.toHaveBeenCalled();
    expect(readText).not.toHaveBeenCalled();
  });

  it("Shift+right-click pastes even when the agent tracks the mouse, since xterm does not send it the click", async () => {
    vi.stubGlobal("navigator", { clipboard: { readText: async () => "hello" } });
    const term = fakeTerminal("", true);
    terminal(term);
    rightClick(term.element, true);
    await flush();
    expect(term.paste.mock.calls).toEqual([["hello"]]);
  });

  it("an empty clipboard pastes nothing", async () => {
    vi.stubGlobal("navigator", { clipboard: { readText: async () => "" } });
    const term = fakeTerminal();
    terminal(term);
    rightClick(term.element);
    await flush();
    expect(term.paste).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });

  it("says why when the clipboard cannot be read", async () => {
    vi.stubGlobal("navigator", {});
    const term = fakeTerminal();
    terminal(term);
    rightClick(term.element);
    await flush();
    expect(term.paste).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(expect.any(String), "error");
  });

  it("stops listening when the terminal closes", async () => {
    vi.stubGlobal("navigator", { clipboard: { readText: async () => "x" } });
    const term = fakeTerminal();
    terminal(term)();
    const event = rightClick(term.element);
    await flush();
    expect(event.defaultPrevented).toBe(false);
    expect(term.paste).not.toHaveBeenCalled();
  });
});
