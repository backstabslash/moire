import type { FileDiff, LineRef } from "../../../shared/types";
import type { Row } from "./rows";

export type Col = "a" | "b" | "u";

export const lineKey = (hunk: number, idx: number) => `${hunk}:${idx}`;
export const gapKey = (newNo: number) => `g${newNo}`;

export function columnKeys(rows: Row[], col: Col): string[] {
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

interface Picked {
  kind: "ctx" | "add" | "del";
  text: string;
  no: number;
}

function pickable(rows: Row[]): Map<string, Picked> {
  const out = new Map<string, Picked>();
  for (const r of rows) {
    if (r.t === "split") {
      if (r.a?.sel) out.set(r.a.sel, { kind: r.kind === "ctx" ? "ctx" : "del", text: r.a.text, no: r.a.no });
      if (r.b?.sel) out.set(r.b.sel, { kind: r.kind === "ctx" ? "ctx" : "add", text: r.b.text, no: r.b.no });
    } else if (r.t === "uni" && r.line.sel) {
      out.set(r.line.sel, { kind: r.kind, text: r.line.text, no: r.line.no });
    }
  }
  return out;
}

function byText(lines: Map<string, Picked>): Map<string, { key: string; no: number }[]> {
  const out = new Map<string, { key: string; no: number }[]>();
  for (const [key, line] of lines) {
    const id = `${line.kind}\0${line.text}`;
    const list = out.get(id) ?? [];
    list.push({ key, no: line.no });
    out.set(id, list);
  }
  return out;
}

// Finds each selected line again after the file changed, or returns null once any of them is gone.
export function carryKeys(before: Row[], after: Row[], keys: ReadonlySet<string>): Map<string, string> | null {
  const old = pickable(before);
  const [was, now] = [byText(old), byText(pickable(after))];
  const wanted = [...old].filter(([key]) => keys.has(key));
  if (wanted.length !== keys.size) return null;
  const ids = wanted.map(([, line]) => `${line.kind}\0${line.text}`);
  const candidates = ids.map((id) => now.get(id) ?? []);
  const unique = candidates.findIndex((c) => c.length === 1);
  if (unique < 0) {
    // Only look-alikes: once their count changes, a lone `}` could land on a `}` the agent just added.
    if (ids.some((id, i) => candidates[i].length !== was.get(id)!.length)) return null;
    return new Map(wanted.map(([key], i) => [key, candidates[i][was.get(ids[i])!.findIndex((c) => c.key === key)].key]));
  }
  let shift = candidates[unique][0].no - wanted[unique][1].no;
  const used = new Set<string>();
  const out = new Map<string, string>();
  for (const [i, [key, line]] of wanted.entries()) {
    let best: { key: string; no: number } | null = null;
    for (const c of candidates[i]) {
      if (used.has(c.key)) continue;
      if (!best || Math.abs(c.no - line.no - shift) < Math.abs(best.no - line.no - shift)) best = c;
    }
    if (!best) return null;
    used.add(best.key);
    out.set(key, best.key);
    shift = best.no - line.no;
  }
  return out;
}
