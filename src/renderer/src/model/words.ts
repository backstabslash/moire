import { diffWordsWithSpace } from "diff";

export type Range = [start: number, end: number];

const MAX_LINE_PAIR = 1000;

// Word marks only help when most of the line survived; otherwise the whole line is the change.
const MIN_SHARED = 0.4;

export function wordRanges(a: string, b: string): [Range[], Range[]] | null {
  if (a.length + b.length > MAX_LINE_PAIR || a === b) return null;
  const aRanges: Range[] = [];
  const bRanges: Range[] = [];
  let ai = 0;
  let bi = 0;
  let shared = 0;
  for (const part of diffWordsWithSpace(a, b)) {
    const n = part.value.length;
    if (part.added) {
      push(bRanges, bi, bi + n);
      bi += n;
    } else if (part.removed) {
      push(aRanges, ai, ai + n);
      ai += n;
    } else {
      ai += n;
      bi += n;
      shared += part.value.trim().length;
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
