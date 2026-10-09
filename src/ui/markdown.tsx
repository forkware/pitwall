// A small Markdown reader for task descriptions: headings, lists, paragraphs, code, bold and inline code.
// It builds React elements, never HTML, so a description cannot inject anything into the page.
import type { ReactNode } from "react";
import { clsx as cx } from "clsx";

export type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "code"; text: string };

export function parseMarkdown(source: string): Block[] {
  const blocks: Block[] = [];
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) code.push(lines[i]);
      blocks.push({ kind: "code", text: code.join("\n") });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: "heading", level: heading[1].length, text: heading[2].trim() });
      continue;
    }
    const item = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line);
    if (item) {
      flush();
      const ordered = !item[1];
      const last = blocks.at(-1);
      if (last?.kind === "list" && last.ordered === ordered) last.items.push(item[3]);
      else blocks.push({ kind: "list", ordered, items: [item[3]] });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    // A line indented under a list item goes on with it.
    const last = blocks.at(-1);
    if (!paragraph.length && last?.kind === "list" && /^\s+\S/.test(line)) {
      last.items[last.items.length - 1] += ` ${line.trim()}`;
      continue;
    }
    paragraph.push(line.trim());
  }
  flush();
  return blocks;
}

export type Inline = { kind: "text" | "bold" | "code"; text: string };

/** `code` and **bold** in a line; everything else is text. */
export function parseInline(text: string): Inline[] {
  const parts: Inline[] = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*/g;
  let at = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > at) parts.push({ kind: "text", text: text.slice(at, m.index) });
    parts.push(m[1] !== undefined ? { kind: "code", text: m[1] } : { kind: "bold", text: m[2] });
    at = m.index + m[0].length;
  }
  if (at < text.length) parts.push({ kind: "text", text: text.slice(at) });
  return parts;
}

function Line({ text }: { text: string }) {
  return (
    <>
      {parseInline(text).map((p, i) =>
        p.kind === "code" ? (
          <code key={i} className="rounded bg-raised px-1 font-mono text-[12px]">
            {p.text}
          </code>
        ) : p.kind === "bold" ? (
          <strong key={i} className="font-semibold">
            {p.text}
          </strong>
        ) : (
          p.text
        ),
      )}
    </>
  );
}

export function Markdown({ source, className }: { source: string; className?: string }) {
  const blocks = parseMarkdown(source);
  const out: ReactNode[] = blocks.map((b, i) => {
    switch (b.kind) {
      case "heading":
        return (
          <h4 key={i} className="mb-1 mt-3 text-[13px] font-semibold first:mt-0">
            <Line text={b.text} />
          </h4>
        );
      case "list": {
        const List = b.ordered ? "ol" : "ul";
        return (
          <List key={i} className={cx("mb-1.5 space-y-0.5 pl-5", b.ordered ? "list-decimal" : "list-disc")}>
            {b.items.map((item, j) => (
              <li key={j}>
                <Line text={item} />
              </li>
            ))}
          </List>
        );
      }
      case "code":
        return (
          <pre key={i} className="mb-1.5 overflow-x-auto whitespace-pre-wrap rounded-md bg-raised p-2 font-mono text-[12px]">
            {b.text}
          </pre>
        );
      default:
        return (
          <p key={i} className="mb-1.5">
            <Line text={b.text} />
          </p>
        );
    }
  });
  return <div className={cx("select-text text-[13px] leading-relaxed", className)}>{out}</div>;
}
