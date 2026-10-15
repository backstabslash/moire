import type { FileContents, FileDiff } from "../../../shared/types";
import { buildRows, type Row } from "./rows";

export type SearchSide = "a" | "b" | "both";

export interface SearchOptions {
  query: string;
  matchCase: boolean;
  regex: boolean;
  side: SearchSide;
}

export interface Hit {
  path: string;
  sel: string;
  start: number;
  end: number;
}

export const MAX_HITS = 5000;
const NONE: ReadonlySet<string> = new Set();

export interface Find {
  pattern: RegExp;
  index: number;
  tick: number;
}

export function compile(o: SearchOptions): RegExp | "invalid" | null {
  if (!o.query) return null;
  try {
    return new RegExp(o.regex ? o.query : o.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), o.matchCase ? "g" : "gi");
  } catch {
    return "invalid";
  }
}

export function searchFile(file: FileDiff, contents: FileContents | null, re: RegExp, side: SearchSide, limit: number): Hit[] {
  const hits: Hit[] = [];
  for (const row of buildRows(file, contents, { layout: "unified", scope: "full", expanded: NONE, showAll: true })) {
    if (row.t !== "uni" || !row.line.sel) continue;
    if ((row.kind === "del" && side === "b") || (row.kind === "add" && side === "a")) continue;
    for (const m of row.line.text.matchAll(re)) {
      if (!m[0]) continue;
      hits.push({ path: file.path, sel: row.line.sel, start: m.index, end: m.index + m[0].length });
      if (hits.length >= limit) return hits;
    }
  }
  return hits;
}

export function hitRow(rows: Row[], hit: Hit): number {
  return rows.findIndex((r) => (r.t === "split" && (r.a?.sel === hit.sel || r.b?.sel === hit.sel)) || (r.t === "uni" && r.line.sel === hit.sel));
}

// The fold or folded-hunk keys to expand so the hit's line gets a row.
export function hitKeys(rows: Row[], hit: Hit): string[] {
  const n = hit.sel.startsWith("g") ? Number(hit.sel.slice(1)) : NaN;
  const covers = (from: number, count: number) => n >= from && n < from + count;
  return rows.flatMap((r) =>
    r.t === "fold" && covers(r.newFrom, r.count)
      ? [r.key]
      : r.t === "hunk" && r.folded && (hit.sel.startsWith(`${r.hunk}:`) || r.folded.gaps.some(([from, count]) => covers(from, count)))
        ? r.folded.keys
        : [],
  );
}
