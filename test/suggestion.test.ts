import { describe, expect, it } from "vitest";
import { arrowMove, isEmpty, joinChoice, shownSuggestion, splitChoice, takeSuggestion } from "../src/ui/suggestion.ts";

describe("a field's suggested answer", () => {
  it("shows only in an empty field, so typing hides it", () => {
    expect(shownSuggestion("", " The main one ")).toBe("The main one");
    expect(shownSuggestion("Th", "The main one")).toBeUndefined();
    expect(shownSuggestion("", undefined)).toBeUndefined();
    expect(shownSuggestion("", "  ")).toBeUndefined();
  });

  it("is typed in by Tab, and then is the field's value to edit", () => {
    expect(takeSuggestion({ key: "Tab" }, "", "The main one")).toBe("The main one");
    // Once there, Tab moves on as usual and the text is the user's.
    expect(takeSuggestion({ key: "Tab" }, "The main one", "The main one")).toBeUndefined();
  });

  it("leaves Tab alone when the user typed their own text, or with modifiers", () => {
    expect(takeSuggestion({ key: "Tab" }, "my own", "The main one")).toBeUndefined();
    expect(takeSuggestion({ key: "Tab", shiftKey: true }, "", "The main one")).toBeUndefined();
    expect(takeSuggestion({ key: "Enter" }, "", "The main one")).toBeUndefined();
    expect(takeSuggestion({ key: "Tab" }, "", undefined)).toBeUndefined();
  });
});

describe("a choice field", () => {
  const options = ["Linux", "macOS"];

  it("splits its value into the options picked and the user's own text", () => {
    expect(splitChoice(["macOS", "FreeBSD", "Linux"], options)).toEqual({ picked: ["Linux", "macOS"], other: "FreeBSD" });
    expect(splitChoice("Linux", options)).toEqual({ picked: ["Linux"], other: undefined });
    expect(splitChoice(undefined, options)).toEqual({ picked: [], other: undefined });
  });

  it("sends one string, or a list for several, with the user's own text last", () => {
    expect(joinChoice(["Linux"], undefined)).toBe("Linux");
    expect(joinChoice([], " FreeBSD ")).toBe("FreeBSD");
    expect(joinChoice([], undefined)).toBe("");
    expect(joinChoice(["Linux", "macOS"], "FreeBSD", true)).toEqual(["Linux", "macOS", "FreeBSD"]);
    expect(joinChoice(["Linux"], "  ", true)).toEqual(["Linux"]);
  });

  it("marks the suggested options until something is picked; Tab picks them", () => {
    expect(shownSuggestion([], ["Linux"])).toEqual(["Linux"]);
    expect(shownSuggestion(["macOS"], ["Linux"])).toBeUndefined();
    expect(takeSuggestion({ key: "Tab" }, [], ["Linux", "macOS"])).toEqual(["Linux", "macOS"]);
    expect(isEmpty([" "])).toBe(true);
  });
});

describe("arrows in a choice", () => {
  it("move the focus among the options, wrapping at the ends", () => {
    expect(arrowMove("ArrowRight", 0, 3)).toBe(1);
    expect(arrowMove("ArrowDown", 2, 3)).toBe(0);
    expect(arrowMove("ArrowLeft", 0, 3)).toBe(2);
    expect(arrowMove("ArrowUp", 1, 3)).toBe(0);
    expect(arrowMove("Home", 2, 3)).toBe(0);
    expect(arrowMove("End", 0, 3)).toBe(2);
    expect(arrowMove(" ", 0, 3)).toBeUndefined();
  });
});
