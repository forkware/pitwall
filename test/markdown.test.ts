import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown } from "../src/ui/markdown.tsx";

describe("parseMarkdown", () => {
  it("reads a refined description: headings, paragraphs and lists", () => {
    const blocks = parseMarkdown("## Цель\nКнопка экспорта\nсохраняет файл.\n\n## Что сделать\n- Плагин.\n- Тест.\n\n1. one\n2. two");
    expect(blocks).toEqual([
      { kind: "heading", level: 2, text: "Цель" },
      { kind: "paragraph", text: "Кнопка экспорта сохраняет файл." },
      { kind: "heading", level: 2, text: "Что сделать" },
      { kind: "list", ordered: false, items: ["Плагин.", "Тест."] },
      { kind: "list", ordered: true, items: ["one", "two"] },
    ]);
  });

  it("keeps fenced code as it is and joins a list item's indented lines", () => {
    expect(parseMarkdown("```\n# not a heading\n  x\n```\n- item\n  goes on")).toEqual([
      { kind: "code", text: "# not a heading\n  x" },
      { kind: "list", ordered: false, items: ["item goes on"] },
    ]);
  });

  it("reads plain words the user typed as one paragraph", () => {
    expect(parseMarkdown("Сделай экспорт задачи")).toEqual([{ kind: "paragraph", text: "Сделай экспорт задачи" }]);
    expect(parseMarkdown("")).toEqual([]);
  });
});

describe("parseInline", () => {
  it("finds code and bold, leaves the rest as text", () => {
    expect(parseInline("run `pnpm test` **now**, please")).toEqual([
      { kind: "text", text: "run " },
      { kind: "code", text: "pnpm test" },
      { kind: "text", text: " " },
      { kind: "bold", text: "now" },
      { kind: "text", text: ", please" },
    ]);
  });
});
