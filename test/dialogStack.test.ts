import { describe, expect, it } from "vitest";
import { createDialogStack } from "../src/ui/dialogStack.ts";

const shown = (stack: ReturnType<typeof createDialogStack<string>>) =>
  stack
    .entries()
    .filter((e) => e.open)
    .map((e) => e.dialog);

describe("dialogs opened from code", () => {
  it("keeps the new-folder dialog open under the directory picker, so Create still creates the folder", () => {
    const stack = createDialogStack<string>();
    stack.open("new folder");
    const picker = stack.open("directory picker");
    expect(shown(stack)).toEqual(["new folder", "directory picker"]);
    // Choose closes the picker only.
    stack.close(picker);
    expect(shown(stack)).toEqual(["new folder"]);
  });

  it("leaves open the dialog a closing one opened", () => {
    const stack = createDialogStack<string>();
    const asking = stack.open("prompt");
    stack.open("next question");
    stack.close(asking);
    expect(shown(stack)).toEqual(["next question"]);
  });

  it("keeps a closed dialog for its exit animation until the next one opens", () => {
    const stack = createDialogStack<string>();
    stack.close(stack.open("confirm"));
    expect(stack.entries()).toMatchObject([{ dialog: "confirm", open: false }]);
    stack.open("prompt");
    expect(stack.entries()).toMatchObject([{ dialog: "prompt", open: true }]);
  });

  it("tells the host when the dialogs change", () => {
    const stack = createDialogStack<string>();
    let calls = 0;
    const off = stack.subscribe(() => calls++);
    stack.close(stack.open("confirm"));
    off();
    stack.open("prompt");
    expect(calls).toBe(2);
  });
});
