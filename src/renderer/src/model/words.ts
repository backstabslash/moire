import { diffArrays } from "diff";

export type Range = [start: number, end: number];

const MAX_LINE_PAIR = 10000;
const MAX_EDITS = 200;

const MIN_SHARED = 0.4;

// A number stays whole, since 2.1% to 0.4% marked digit by digit can't be read.
const TOKEN = /\d+(?:[.,]\d+)*%?|[\p{L}\p{M}\p{N}_]+|\s+|[^]/gu;
const tokens = (text: string) => text.match(TOKEN) ?? [];

export function wordRanges(a: string, b: string): [Range[], Range[]] | null {
  if (a.length + b.length > MAX_LINE_PAIR || a === b) return null;
  const aRanges: Range[] = [];
  const bRanges: Range[] = [];
  let ai = 0;
  let bi = 0;
  let shared = 0;
  const parts = diffArrays(tokens(a), tokens(b), { maxEditLength: MAX_EDITS });
  if (!parts) return null;
  for (const part of parts) {
    const value = part.value.join("");
    const n = value.length;
    if (part.added) {
      push(bRanges, bi, bi + n);
      bi += n;
    } else if (part.removed) {
      push(aRanges, ai, ai + n);
      ai += n;
    } else {
      ai += n;
      bi += n;
      shared += value.trim().length;
    }
  }
  const shorter = Math.min(a.trim().length, b.trim().length);
  if (shared < shorter * MIN_SHARED) return null;
  return [aRanges, bRanges];
}

function push(ranges: Range[], start: number, end: number) {
  const last = ranges[ranges.length - 1];
  if (last && last[1] === start) last[1] = end;
  else ranges.push([start, end]);
}

export function cutsAt(a: Range[], b: Range[]): { at: number; cut: Range }[] {
  const out: { at: number; cut: Range }[] = [];
  let ai = 0;
  let bi = 0;
  let x = 0;
  let y = 0;
  while (x < a.length) {
    const shared = Math.min(a[x][0] - ai, y < b.length ? b[y][0] - bi : Infinity);
    ai += shared;
    bi += shared;
    if (ai === a[x][0]) {
      out.push({ at: bi, cut: a[x] });
      ai = a[x++][1];
    }
    if (y < b.length && bi === b[y][0]) bi = b[y++][1];
  }
  return out;
}

const CONFETTI_EDITS = 6;
const MERGE_GAP_CHARS = 16;

// A heavy rewrite shares stray words like "the", and marking around each one reads worse than marking the phrase.
export function mergeEdits(a: string, [cut, put]: [Range[], Range[]]): [Range[], Range[]] {
  const edits: { a: Range; b: Range }[] = [];
  let ai = 0;
  let bi = 0;
  let x = 0;
  let y = 0;
  while (x < cut.length || y < put.length) {
    const shared = Math.min(x < cut.length ? cut[x][0] - ai : Infinity, y < put.length ? put[y][0] - bi : Infinity);
    ai += shared;
    bi += shared;
    const edit = { a: [ai, ai] as Range, b: [bi, bi] as Range };
    if (x < cut.length && cut[x][0] === ai) edit.a[1] = ai = cut[x++][1];
    if (y < put.length && put[y][0] === bi) edit.b[1] = bi = put[y++][1];
    edits.push(edit);
  }
  if (edits.length < CONFETTI_EDITS) return [cut, put];
  const merged = [edits[0]];
  for (const edit of edits.slice(1)) {
    const last = merged[merged.length - 1];
    if (a.slice(last.a[1], edit.a[0]).trim().length > MERGE_GAP_CHARS) {
      merged.push(edit);
      continue;
    }
    last.a[1] = edit.a[1];
    last.b[1] = edit.b[1];
  }
  const nonEmpty = (r: Range) => r[1] > r[0];
  return [merged.map((e) => e.a).filter(nonEmpty), merged.map((e) => e.b).filter(nonEmpty)];
}
