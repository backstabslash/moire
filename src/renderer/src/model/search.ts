import type { FileContents, FileDiff } from "../../../shared/types";
import { buildRows } from "./rows";

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
