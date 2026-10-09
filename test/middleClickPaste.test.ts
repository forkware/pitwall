import { describe, expect, it } from "vitest";
import { guardMiddleClickPaste } from "../src/ui/middleClickPaste.ts";

function mouseUp(element: EventTarget, button: number, shiftKey = false) {
  const event = Object.assign(new Event("mouseup", { cancelable: true }), { button, shiftKey });
  element.dispatchEvent(event);
  return event;
}

/** A terminal element whose hidden input types every paste that reaches it into the agent. */
function setup(tracksMouse: boolean) {
  const element = new EventTarget();
  let time = 0;
  const stop = guardMiddleClickPaste(element, () => tracksMouse, () => time);
  // After the guard, as xterm's input inside the element hears a paste after the element's capture listener.
  const typed: string[] = [];
  element.addEventListener("paste", (e) => typed.push((e as Event & { text: string }).text));
  const paste = (text: string) => {
    const event = Object.assign(new Event("paste", { cancelable: true }), { text });
    element.dispatchEvent(event);
    return event;
  };
  return { element, typed, paste, stop, wait: (ms: number) => (time += ms) };
}

describe("middle-click paste", () => {
  it("does not paste the selection a second time into an agent that tracks the mouse (#46)", () => {
    const { element, typed, paste } = setup(true);
    expect(mouseUp(element, 1).defaultPrevented).toBe(true);
    expect(paste("hello").defaultPrevented).toBe(true);
    expect(typed).toEqual([]);
  });

  it("pastes once when the agent does not track the mouse", () => {
    const { element, typed, paste } = setup(false);
    expect(mouseUp(element, 1).defaultPrevented).toBe(false);
    paste("hello");
    expect(typed).toEqual(["hello"]);
  });

  it("Shift+middle-click is the terminal's: it pastes once", () => {
    const { element, typed, paste } = setup(true);
    mouseUp(element, 1, true);
    paste("hello");
    expect(typed).toEqual(["hello"]);
  });

  it("a paste from the keyboard or the menu goes through once", () => {
    const { element, typed, paste, wait } = setup(true);
    paste("hello");
    mouseUp(element, 0);
    paste("hello");
    mouseUp(element, 1);
    wait(1000);
    paste("hello");
    expect(typed).toEqual(["hello", "hello", "hello"]);
  });

  it("blocks only the one paste of the click", () => {
    const { element, typed, paste } = setup(true);
    mouseUp(element, 1);
    paste("hello");
    paste("hello");
    expect(typed).toEqual(["hello"]);
  });

  it("stops when the terminal closes", () => {
    const { element, typed, paste, stop } = setup(true);
    stop();
    expect(mouseUp(element, 1).defaultPrevented).toBe(false);
    paste("hello");
    expect(typed).toEqual(["hello"]);
  });
});
