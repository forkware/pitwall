import { describe, expect, it } from "vitest";
import { clearDraft, loadDraft, saveDraft } from "../src/ui/formDrafts.ts";

function memory() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    map,
  };
}

describe("process form drafts", () => {
  it("restores what was typed when the task is opened again", () => {
    const store = memory();
    saveDraft("t1", 1, { prompt: "fix the login" }, store);
    expect(loadDraft("t1", 1, store)).toEqual({ prompt: "fix the login" });
  });

  it("keeps each task's draft apart", () => {
    const store = memory();
    saveDraft("t1", 1, { prompt: "one" }, store);
    saveDraft("t2", 1, { prompt: "two" }, store);
    expect(loadDraft("t1", 1, store)).toEqual({ prompt: "one" });
    expect(loadDraft("t2", 1, store)).toEqual({ prompt: "two" });
    expect(loadDraft("t3", 1, store)).toEqual({});
  });

  it("does not offer a draft to a different question", () => {
    const store = memory();
    saveDraft("t1", 1, { prompt: "old" }, store);
    expect(loadDraft("t1", 2, store)).toEqual({});
  });

  it("forgets the draft after the form is sent or emptied", () => {
    const store = memory();
    saveDraft("t1", 1, { prompt: "sent" }, store);
    clearDraft("t1", store);
    expect(loadDraft("t1", 1, store)).toEqual({});
    saveDraft("t1", 1, { prompt: "x" }, store);
    saveDraft("t1", 1, { prompt: "" }, store);
    expect(store.map.size).toBe(0);
  });

  it("works without storage", () => {
    saveDraft("t1", 1, { prompt: "x" }, undefined);
    expect(loadDraft("t1", 1, undefined)).toEqual({});
  });
});
