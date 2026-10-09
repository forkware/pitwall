import { describe, expect, it, vi } from "vitest";
import { onTreeSpace } from "../../../src/ui/treeKeys.ts";

const { openNewFolderDialog } = vi.hoisted(() => ({ openNewFolderDialog: vi.fn() }));
vi.mock("../../../src/ui/components/FolderProcesses.tsx", async (original) => ({
  ...(await original<object>()),
  openNewFolderDialog,
}));

const plugin = (await import("../ui.tsx")).default;

/** An element whose closest() matches when one of `inside` is among the selectors it is asked for. */
const target = (...inside: string[]) => ({
  closest: (selector: string) => (selector.split(", ").some((s) => inside.includes(s)) ? {} : null),
});

describe("the tree's empty space", () => {
  it("is not a row, a button or a field", () => {
    expect(onTreeSpace(target() as unknown as EventTarget)).toBe(true);
    expect(onTreeSpace(target("[data-tree-id]") as unknown as EventTarget)).toBe(false);
    expect(onTreeSpace(target("button") as unknown as EventTarget)).toBe(false);
    expect(onTreeSpace(target("input") as unknown as EventTarget)).toBe(false);
  });

  it("gets a New folder item that opens the dialog for the top level", () => {
    const Item = plugin.slots?.["tree.menu"] as unknown as () => { props: { onSelect: () => void; children: unknown } };
    expect(Item).toBeTypeOf("function");
    const item = Item();
    expect(item.props.children).toBe("New folder");
    item.props.onSelect();
    expect(openNewFolderDialog).toHaveBeenCalledWith(null);
  });
});
