import type { DiffLine, FileContents, FileDiff, Hunk } from "../../../shared/types";
import { langFor } from "./lang";
import { gapKey, lineKey } from "./selection";
import { type Range, wordRanges } from "./words";

export type Layout = "split" | "unified";
export type Scope = "changed" | "full";

const INDENTED = new Set(["python", "yaml", "make", "haskell", "fsharp", "nim", "coffee", "pug", "haml", "sass", "stylus", "elm"]);

export interface Side {
  no: number;
  text: string;
  words?: Range[];
  sel?: string;
  staged?: boolean;
}

export type Row =
  | { t: "hunk"; key: string; hunk: number; label: string; ctx: string; adds: number; dels: number; staged: "full" | "partial" | null; folded?: Folded }
  | { t: "fold"; key: string; count: number; expandable: boolean; newFrom: number }
  | { t: "split"; key: string; hunk: number; kind: "ctx" | "chg"; a?: Side; b?: Side; faded?: boolean }
  | { t: "uni"; key: string; hunk: number; kind: "ctx" | "add" | "del"; a?: number; b?: number; line: Side; faded?: boolean }
  | { t: "note"; key: string; text: string; expand?: string };

export interface Folded {
  keys: string[];
  count: number;
  gaps: [newFrom: number, count: number][];
}

export interface BuildOptions {
  layout: Layout;
  scope: Scope;
  expanded: ReadonlySet<string>;
  showAll?: boolean;
  plates?: number;
}

export function buildRows(file: FileDiff, contents: FileContents | null, opts: BuildOptions): Row[] {
  if (file.status === "unchanged") return wholeFile(contents);
  if (file.binary) return [{ t: "note", key: "note", text: "Binary file, contents not shown." }];
  if (file.unread)
    return [{ t: "note", key: "note", text: "Not read: there are over 1,000 untracked files. Add their folder to .gitignore, or stage it whole." }];
  if (file.tooLarge) return [{ t: "note", key: "note", text: "File is over 2 MB, contents not shown." }];
  if (file.status === "conflicted")
    return [{ t: "note", key: "note", text: "Merge conflict. Resolve it in your editor (e); the All view (3) shows it with the markers." }];
  if (file.noise && !opts.showAll && !opts.expanded.has("noise")) {
    const n = file.additions + file.deletions;
    return [{ t: "note", key: "noise", text: `${file.noise}, ${n} changed ${n === 1 ? "line" : "lines"}, folded away.`, expand: "noise" }];
  }
  if (!file.hunks.length) {
    const text = file.status === "renamed" ? "Renamed without content changes." : "No content changes.";
    return [{ t: "note", key: "note", text }];
  }

  const bLines = splitLines(contents?.b ?? null);
  const aLines = splitLines(contents?.a ?? null);
  const gapText = (oldNo: number, newNo: number) => (bLines ? bLines[newNo - 1] : aLines?.[oldNo - 1]) ?? "";
  const rows: Row[] = [];
  let oldNext = 1;
  let newNext = 1;

  const emitGap = (key: string, oldFrom: number, newFrom: number, count: number) => {
    if (count <= 0) return;
    const expandable = bLines !== null || aLines !== null;
    if (expandable && (opts.scope === "full" || opts.expanded.has(key))) {
      for (let i = 0; i < count; i++) {
        emitContext(rows, opts.layout, `${key}:${i}`, -1, oldFrom + i, newFrom + i, gapText(oldFrom + i, newFrom + i), gapKey(newFrom + i));
      }
    } else {
      rows.push({ t: "fold", key, count, expandable, newFrom });
    }
  };

  const indented = INDENTED.has(langFor(file.path));
  file.hunks.forEach((hunk, h) => {
    const oldFirst = hunk.oldLines === 0 ? hunk.oldStart + 1 : hunk.oldStart;
    const newFirst = hunk.newLines === 0 ? hunk.newStart + 1 : hunk.newStart;
    emitGap(`gap${h}`, oldNext, newNext, newFirst - newNext);
    const key = `ws${h}`;
    if (!opts.showAll && !opts.expanded.has(key) && whitespaceOnly(hunk, indented)) {
      rows.push({ ...hunkRow(hunk, h), folded: { keys: [key], count: 0, gaps: [] } });
    } else {
      rows.push(hunkRow(hunk, h));
      emitHunkLines(rows, h === opts.plates ? "split" : opts.layout, hunk, h);
    }
    oldNext = oldFirst + hunk.oldLines;
    newNext = newFirst + hunk.newLines;
  });

  const trailing = bLines ? bLines.length - newNext + 1 : aLines ? aLines.length - oldNext + 1 : 0;
  emitGap(`gap${file.hunks.length}`, oldNext, newNext, trailing);
  return absorbGaps(rows);
}

function absorbGaps(rows: Row[]): Row[] {
  const out: Row[] = [];
  const take = (f: Folded, gap: Row & { t: "fold" }, before: boolean) => {
    f.keys[before ? "unshift" : "push"](gap.key);
    f.count += gap.count;
    f.gaps.push([gap.newFrom, gap.count]);
  };
  for (const row of rows) {
    const last = out.at(-1);
    if (row.t === "hunk" && row.folded && last?.t === "fold" && last.expandable) {
      out.pop();
      take(row.folded, last, true);
      out.push(row);
    } else if (row.t === "fold" && row.expandable && last?.t === "hunk" && last.folded) {
      take(last.folded, row, false);
    } else {
      out.push(row);
    }
  }
  return out;
}

function wholeFile(contents: FileContents | null): Row[] {
  if (!contents) return [];
  if (contents.tooLarge) return [{ t: "note", key: "note", text: "Binary file or over 2 MB, contents not shown." }];
  const lines = splitLines(contents.b);
  if (!lines) return [{ t: "note", key: "note", text: "Can't read this file." }];
  if (!lines.length) return [{ t: "note", key: "note", text: "Empty file." }];
  const rows: Row[] = [];
  lines.forEach((text, i) => emitContext(rows, "unified", `l${i}`, -1, i + 1, i + 1, text, gapKey(i + 1)));
  return rows;
}

function whitespaceOnly(hunk: Hunk, indented: boolean): boolean {
  const squash = (kind: "add" | "del") => {
    const texts = hunk.lines.filter((l) => l.kind === kind).map((l) => l.text);
    if (!indented) return dropSpaces(texts.join("\n"));
    return texts
      .filter((t) => t.trim())
      .map((t) => t.match(/^\s*/)![0] + dropSpaces(t))
      .join("\n");
  };
  return hunk.lines.some((l) => l.kind !== "ctx") && squash("add") === squash("del");
}

// Whitespace between two word characters still matters: `a b` isn't `ab`.
function dropSpaces(text: string): string {
  const word = /[\p{L}\p{N}_$]/u;
  return text.trim().replace(/\s+/g, (gap, at: number, s: string) => (word.test(s[at - 1] ?? "") && word.test(s[at + gap.length] ?? "") ? " " : ""));
}

export function splitLines(text: string | null): string[] | null {
  if (text === null) return null;
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function hunkRow(hunk: Hunk, h: number): Row & { t: "hunk" } {
  let adds = 0;
  let dels = 0;
  let staged = 0;
  for (const l of hunk.lines) {
    if (l.kind === "add") adds++;
    else if (l.kind === "del") dels++;
    if (l.staged) staged++;
  }
  return {
    t: "hunk",
    key: `hunk${h}`,
    hunk: h,
    label: `−${hunk.oldStart},${hunk.oldLines}  +${hunk.newStart},${hunk.newLines}`,
    ctx: hunk.header.trim(),
    adds,
    dels,
    staged: staged === 0 ? null : staged === adds + dels ? "full" : "partial",
  };
}

function emitContext(rows: Row[], layout: Layout, key: string, h: number, oldNo: number, newNo: number, text: string, sel: string, faded = false) {
  if (layout === "split") {
    rows.push({ t: "split", key, hunk: h, kind: "ctx", a: { no: oldNo, text, sel }, b: { no: newNo, text, sel }, faded });
  } else {
    rows.push({ t: "uni", key, hunk: h, kind: "ctx", a: oldNo, b: newNo, line: { no: newNo, text, sel }, faded });
  }
}

function emitHunkLines(rows: Row[], layout: Layout, hunk: Hunk, h: number) {
  const lines = hunk.lines;
  const faded = lines.every((l) => l.kind === "ctx" || l.staged);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.kind === "ctx") {
      emitContext(rows, layout, `h${h}:${i}`, h, line.oldNo!, line.newNo!, line.text, lineKey(h, i), faded);
      i++;
      continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    const start = i;
    while (i < lines.length && lines[i].kind === "del") dels.push(lines[i++]);
    while (i < lines.length && lines[i].kind === "add") adds.push(lines[i++]);

    const delSides = dels.map((l, k): Side => ({ no: l.oldNo!, text: l.text, sel: lineKey(h, start + k), staged: l.staged }));
    const addSides = adds.map((l, k): Side => ({ no: l.newNo!, text: l.text, sel: lineKey(h, start + dels.length + k), staged: l.staged }));
    const pairs = align(delSides, addSides);

    if (layout === "split") {
      pairs.forEach(([a, b], k) => rows.push({ t: "split", key: `h${h}:${start}:${k}`, hunk: h, kind: "chg", a, b }));
    } else {
      delSides.forEach((s, k) => rows.push({ t: "uni", key: `h${h}:${start}:d${k}`, hunk: h, kind: "del", a: s.no, line: s }));
      addSides.forEach((s, k) => rows.push({ t: "uni", key: `h${h}:${start}:a${k}`, hunk: h, kind: "add", b: s.no, line: s }));
    }
  }
}

export function followHunk(prev: Hunk, hunks: Hunk[]): number {
  const changes = (h: Hunk) => JSON.stringify(h.lines.filter((l) => l.kind !== "ctx").map((l) => [l.kind, l.text]));
  const want = changes(prev);
  let best = 0;
  let score = Infinity;
  hunks.forEach((h, i) => {
    const s = (changes(h) === want ? 0 : 1e9) + Math.abs(h.oldStart - prev.oldStart);
    if (s < score) [best, score] = [i, s];
  });
  return best;
}

const LOOKAHEAD = 8;

export function align(dels: Side[], adds: Side[]): [Side | undefined, Side | undefined][] {
  const matches: [number, number][] = [];
  let next = 0;
  dels.forEach((del, i) => {
    for (let k = next; k < adds.length && k < next + LOOKAHEAD; k++) {
      const marks = wordRanges(del.text, adds[k].text);
      if (!marks) continue;
      [del.words, adds[k].words] = marks;
      matches.push([i, k]);
      next = k + 1;
      return;
    }
  });

  const out: [Side | undefined, Side | undefined][] = [];
  let di = 0;
  let ai = 0;
  for (const [i, k] of [...matches, [dels.length, adds.length]]) {
    const gapDels = dels.slice(di, i);
    const gapAdds = adds.slice(ai, k);
    for (let n = 0; n < Math.max(gapDels.length, gapAdds.length); n++) out.push([gapDels[n], gapAdds[n]]);
    if (i < dels.length) out.push([dels[i], adds[k]]);
    di = i + 1;
    ai = k + 1;
  }
  return out;
}
