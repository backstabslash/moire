export type Block = "add" | "del" | "none";

const BLOCKS = 5;
const GAUGE_WIDTH = 30;
const GAUGE_STEP = 3;

export function diffBlocks(additions: number, deletions: number, size = BLOCKS): Block[] {
  const total = additions + deletions;
  if (!total) return Array<Block>(size).fill("none");
  // On tiny edits each block is one line, as on GitHub, so they don't look like rewrites.
  const filled = Math.min(size, total);
  let add = Math.round((additions / total) * filled);
  if (additions && !add) add = 1;
  if (deletions && add === filled) add = filled - 1;
  return [...Array<Block>(add).fill("add"), ...Array<Block>(filled - add).fill("del"), ...Array<Block>(size - filled).fill("none")];
}

export function gaugeWidth(lines: number): number {
  return Math.min(GAUGE_WIDTH, Math.ceil(Math.log2(lines + 1)) * GAUGE_STEP);
}

export function shortCount(lines: number): string {
  return lines < 10000 ? String(lines) : `${Math.round(lines / 1000)}k`;
}
