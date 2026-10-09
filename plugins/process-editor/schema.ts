// The schema's layout: the steps top to bottom as in the recipe, the next one straight below, a way that skips steps
// curving on the right, a way back curving on the left, each way on its own lane. No React: the tests use it.
import type { RecipeRow } from "./model.ts";

export const BOX = { w: 248, h: 46, gap: 30, lane: 16, margin: 72 };

export interface SchemaBox {
  node: string;
  row: RecipeRow;
  x: number;
  y: number;
}

export interface SchemaEdge {
  from: string;
  to: string;
  /** "down": to the next step; "skip": further down, on the right; "back": up, on the left; "end": to the end. */
  kind: "down" | "skip" | "back" | "end";
  path: string;
  /** Where its words go. */
  label?: { x: number; y: number; text: string; anchor: "start" | "end" | "middle" };
}

export interface Schema {
  boxes: SchemaBox[];
  edges: SchemaEdge[];
  width: number;
  height: number;
  /** The end marker. */
  end: { x: number; y: number };
}

export function layout(rows: RecipeRow[], words: (row: RecipeRow, part: RecipeRow["next"][number]) => string | undefined): Schema {
  const left = BOX.margin + 8 * BOX.lane;
  const boxes = rows.map((row, i): SchemaBox => ({ node: row.node, row, x: left, y: 16 + i * (BOX.h + BOX.gap) }));
  const at = new Map(boxes.map((b, i) => [b.node, i]));
  const end = { x: left + BOX.w / 2, y: 16 + rows.length * (BOX.h + BOX.gap) + 4 };
  const edges: SchemaEdge[] = [];
  let right = 0;
  let back = 0;
  rows.forEach((row, i) => {
    const box = boxes[i];
    // Labels of ways out of the same box on the same side go one under another.
    const labels = { left: 0, right: 0 };
    // The ways a step goes: its own when it says, else simply the next one.
    const parts = row.next.length ? row.next : row.deadEnd ? [] : [{ to: rows[i + 1]?.node ?? "end", n: i + 2, back: false, end: !rows[i + 1] }];
    for (const part of parts) {
      const j = part.end ? rows.length : (at.get(part.to) ?? -1);
      if (j < 0) continue;
      const text = words(row, part);
      const fromX = box.x + BOX.w / 2;
      const fromY = box.y + BOX.h;
      if (j === i + 1 && !part.end) {
        const toY = boxes[j].y;
        edges.push({ from: row.node, to: part.to, kind: "down", path: `M ${fromX} ${fromY} L ${fromX} ${toY}`, ...(text ? { label: { x: fromX + 6, y: (fromY + toY) / 2 + 4, text, anchor: "start" } } : {}) });
      } else if (part.end && i === rows.length - 1) {
        edges.push({ from: row.node, to: "end", kind: "end", path: `M ${fromX} ${fromY} L ${end.x} ${end.y - 8}`, ...(text ? { label: { x: fromX + 6, y: (fromY + end.y) / 2 + 2, text, anchor: "start" } } : {}) });
      } else if (j === i) {
        // Back to itself ("Start again"): a small loop on its left.
        const y1 = box.y + 10;
        const y2 = box.y + BOX.h - 10;
        const x1 = box.x;
        edges.push({
          from: row.node,
          to: part.to,
          kind: "back",
          path: `M ${x1} ${y1} C ${x1 - 34} ${y1 - 6}, ${x1 - 34} ${y2 + 6}, ${x1} ${y2}`,
          // Its words on the right, clear of the ways back on the left.
          ...(text ? { label: { x: box.x + BOX.w + 6, y: box.y + BOX.h - 4 + labels.right++ * 13, text: `↺ ${text}`, anchor: "start" } } : {}),
        });
      } else if (j > i) {
        const lane = BOX.w + 18 + right++ * BOX.lane;
        const y1 = box.y + BOX.h / 2;
        const y2 = part.end ? end.y : boxes[j].y + BOX.h / 2;
        const x1 = box.x + BOX.w;
        const x2 = part.end ? end.x + 8 : boxes[j].x + BOX.w;
        const xl = box.x + lane;
        edges.push({
          from: row.node,
          to: part.to,
          kind: part.end ? "end" : "skip",
          path: `M ${x1} ${y1} H ${xl - 8} Q ${xl} ${y1} ${xl} ${y1 + 8} V ${y2 - 8} Q ${xl} ${y2} ${xl - 8} ${y2} H ${x2}`,
          ...(text ? { label: { x: x1 + 6, y: y1 - 5 + labels.right++ * 13, text, anchor: "start" } } : {}),
        });
      } else {
        const lane = 18 + back++ * BOX.lane;
        const y1 = box.y + BOX.h / 2;
        const y2 = boxes[j].y + BOX.h / 2;
        const x1 = box.x;
        const xl = box.x - lane;
        edges.push({
          from: row.node,
          to: part.to,
          kind: "back",
          path: `M ${x1} ${y1} H ${xl + 8} Q ${xl} ${y1} ${xl} ${y1 - 8} V ${y2 + 8} Q ${xl} ${y2} ${xl + 8} ${y2} H ${boxes[j].x}`,
          ...(text ? { label: { x: x1 - 6, y: y1 - 5 + labels.left++ * 13, text, anchor: "end" } } : {}),
        });
      }
    }
  });
  return { boxes, edges, end, width: left + BOX.w + 18 + Math.max(right, 1) * BOX.lane + 160, height: end.y + 24 };
}
