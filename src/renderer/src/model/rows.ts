import type { DiffLine, FileContents, FileDiff, Hunk } from "../../../shared/types";
import { gapKey, lineKey } from "./selection";
import { type Range, wordRanges } from "./words";

export type Layout = "split" | "unified";
export type Scope = "changed" | "full";

export interface Side {
  no: number;
  text: string;
  words?: Range[];
  // selection key, see model/selection
  sel?: string;
  staged?: boolean;
}

export type Row =
  | { t: "hunk"; key: string; hunk: number; label: string; ctx: string; adds: number; dels: number; staged: "full" | "partial" | null }
  // label and hunk are set when the fold hides a whitespace-only hunk instead of unchanged lines
  | { t: "fold"; key: string; count: number; expandable: boolean; newFrom: number; label?: string; hunk?: number }
  | { t: "split"; key: string; hunk: number; kind: "ctx" | "chg"; a?: Side; b?: Side; faded?: boolean }
  | { t: "uni"; key: string; hunk: number; kind: "ctx" | "add" | "del"; a?: number; b?: number; line: Side; faded?: boolean }
  | { t: "note"; key: string; text: string; expand?: string };

export interface BuildOptions {
  layout: Layout;
  scope: Scope;
  expanded: ReadonlySet<string>;
  // ignore noise and whitespace folding, for search and copy
  showAll?: boolean;
  // a hunk drawn as aligned split rows whatever the layout, for blinking between plates
  plates?: number;
}

export function buildRows(file: FileDiff, contents: FileContents | null, opts: BuildOptions): Row[] {
  if (file.binary) return [{ t: "note", key: "note", text: "Binary file, contents not shown." }];
  if (file.unread) return [{ t: "note", key: "note", text: "Not read: there are over 1,000 untracked files. Add their folder to .gitignore, or stage it whole." }];
  if (file.tooLarge) return [{ t: "note", key: "note", text: "File is over 2 MB, contents not shown." }];
  if (file.status === "conflicted") return [{ t: "note", key: "note", text: "Merge conflict. Resolve it in your editor (e); the All view (3) shows it with the markers." }];
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

  file.hunks.forEach((hunk, h) => {
    const oldFirst = hunk.oldLines === 0 ? hunk.oldStart + 1 : hunk.oldStart;
    const newFirst = hunk.newLines === 0 ? hunk.newStart + 1 : hunk.newStart;
    emitGap(`gap${h}`, oldNext, newNext, newFirst - newNext);
    rows.push(hunkRow(hunk, h));
    const key = `ws${h}`;
    if (!opts.showAll && !opts.expanded.has(key) && whitespaceOnly(hunk)) {
      rows.push({ t: "fold", key, count: hunk.lines.length, expandable: true, newFrom: newFirst, label: "Whitespace-only changes", hunk: h });
    } else {
      emitHunkLines(rows, h === opts.plates ? "split" : opts.layout, hunk, h);
    }
    oldNext = oldFirst + hunk.oldLines;
    newNext = newFirst + hunk.newLines;
  });

  const trailing = bLines ? bLines.length - newNext + 1 : aLines ? aLines.length - oldNext + 1 : 0;
  emitGap(`gap${file.hunks.length}`, oldNext, newNext, trailing);
  return rows;
}

function whitespaceOnly(hunk: Hunk): boolean {
  const squash = (kind: "add" | "del") =>
    hunk.lines
      .filter((l) => l.kind === kind)
      .map((l) => l.text)
      .join("")
      .replace(/\s+/g, "");
  return hunk.lines.some((l) => l.kind !== "ctx") && squash("add") === squash("del");
}

export function splitLines(text: string | null): string[] | null {
  if (text === null) return null;
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function hunkRow(hunk: Hunk, h: number): Row {
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
  // Context in a fully staged hunk fades with it.
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

// Where a hunk went after the diff was read again: the hunk with the same changes, else the one nearest its old position.
// The old side's numbers stay put while an agent edits the working tree, so position is the better fallback.
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

// Pairs each removed line with a similar added line so an inserted comment doesn't shift every pair below it.
// Lines with no similar partner pair up by position within their gap, which reads best for rewrites.
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
