import type { FileDiff, LineRef } from "../../../shared/types";
import type { Row } from "./rows";

// A gutter column: A or B in split view, the single column in unified view.
export type Col = "a" | "b" | "u";

// Lines inside a hunk are keyed by position in hunk.lines, unchanged lines between hunks by new-side number.
export const lineKey = (hunk: number, idx: number) => `${hunk}:${idx}`;
export const gapKey = (newNo: number) => `g${newNo}`;

function columnKeys(rows: Row[], col: Col): string[] {
  const out: string[] = [];
  for (const r of rows) {
    if (r.t !== "split" && r.t !== "uni") continue;
    const side = r.t === "uni" ? (col === "u" ? r.line : undefined) : col === "u" ? undefined : r[col];
    if (side?.sel) out.push(side.sel);
  }
  return out;
}

export function keysBetween(rows: Row[], col: Col, from: string, to: string): string[] {
  const keys = columnKeys(rows, col);
  const i = keys.indexOf(from);
  const j = keys.indexOf(to);
  if (i < 0 || j < 0) return [to];
  return keys.slice(Math.min(i, j), Math.max(i, j) + 1);
}

// The selected lines that staging can act on.
export function changedRefs(file: FileDiff, keys: Iterable<string>): LineRef[] {
  return [...keys].flatMap((k) => {
    if (k.startsWith("g")) return [];
    const [hunk, line] = k.split(":").map(Number);
    const kind = file.hunks[hunk]?.lines[line]?.kind;
    return kind && kind !== "ctx" ? [{ hunk, line }] : [];
  });
}

export function hunkRefs(file: FileDiff, hunk: number): LineRef[] {
  return (file.hunks[hunk]?.lines ?? []).flatMap((l, line) => (l.kind === "ctx" ? [] : [{ hunk, line }]));
}
