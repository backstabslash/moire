import { diffArrays } from "diff";

export interface Block {
  kind: string;
  source: string;
}

export interface Pair {
  a: number | null;
  b: number | null;
}

const MIN_ALIKE = 0.3;
const ANY_ROW = 0.01;
const MAX_GAP_CELLS = 250_000;
const MAX_EDITS = 2000;

const family = (kind: string) => (/^H[1-6]$/.test(kind) ? "H" : kind);

function tally(source: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const word of source.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []) out.set(word, (out.get(word) ?? 0) + 1);
  return out;
}

function alike(x: Map<string, number>, y: Map<string, number>): number {
  let shared = 0;
  let total = 0;
  for (const [word, n] of x) {
    shared += Math.min(n, y.get(word) ?? 0);
    total += n;
  }
  for (const n of y.values()) total += n;
  return total ? (2 * shared) / total : 0;
}

function matchGap(a: Block[], b: Block[], fromA: number, fromB: number, out: Pair[]) {
  const lone = () => {
    a.forEach((_, i) => out.push({ a: fromA + i, b: null }));
    b.forEach((_, j) => out.push({ a: null, b: fromB + j }));
  };
  if (!a.length || !b.length || a.length * b.length > MAX_GAP_CELLS) return lone();
  const wordsA = a.map((x) => tally(x.source));
  const wordsB = b.map((x) => tally(x.source));
  const score = (i: number, j: number) => {
    if (family(a[i].kind) !== family(b[j].kind)) return 0;
    const s = alike(wordsA[i], wordsB[j]);
    // A rewritten row keeps its place in the table, so it reads as edited cells rather than a row out and a row in.
    if (a[i].kind === "TR") return Math.max(s, ANY_ROW);
    return s >= MIN_ALIKE ? s : 0;
  };
  const best = Array.from({ length: a.length + 1 }, () => new Float64Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      const s = score(i, j);
      best[i][j] = Math.max(best[i + 1][j], best[i][j + 1], s ? s + best[i + 1][j + 1] : 0);
    }
  }
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const s = i < a.length && j < b.length ? score(i, j) : 0;
    if (s && best[i][j] === s + best[i + 1][j + 1]) out.push({ a: fromA + i++, b: fromB + j++ });
    else if (i < a.length && (j === b.length || best[i][j] === best[i + 1][j])) out.push({ a: fromA + i++, b: null });
    else out.push({ a: null, b: fromB + j++ });
  }
}

// Same source lines up first; what's left pairs by shared words, so an edit reads as an edit, not a swap.
export function alignBlocks(a: Block[], b: Block[]): Pair[] {
  const out: Pair[] = [];
  let i = 0;
  let j = 0;
  let gapA = 0;
  let gapB = 0;
  const flush = () => {
    matchGap(a.slice(i - gapA, i), b.slice(j - gapB, j), i - gapA, j - gapB, out);
    gapA = gapB = 0;
  };
  const parts = diffArrays(
    a.map((x) => `${x.kind}\n${x.source}`),
    b.map((x) => `${x.kind}\n${x.source}`),
    { maxEditLength: MAX_EDITS },
  );
  if (!parts) {
    matchGap(a, b, 0, 0, out);
    return out;
  }
  for (const part of parts) {
    const n = part.value.length;
    if (part.removed) {
      i += n;
      gapA += n;
    } else if (part.added) {
      j += n;
      gapB += n;
    } else {
      flush();
      for (let k = 0; k < n; k++) out.push({ a: i++, b: j++ });
    }
  }
  flush();
  return out;
}
