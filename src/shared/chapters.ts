import type { AgentNotes, Chapter, FileDiff, LineRef, NoteRange } from "./types";

export interface Placed {
  start: number;
  end: number;
}

// Where a range's lines are now: all of the file's changes is null, and "lost" means its first line is gone.
export function placeRange(range: NoteRange, lines: string[] | null): Placed | "lost" | null {
  if (!range.lines) return null;
  const [start, end] = range.lines;
  const want = range.code?.trim();
  if (!lines) return { start, end };
  if (!want) return start > lines.length ? "lost" : { start, end };
  if (lines[start - 1]?.trim() === want) return { start, end };
  let best = -1;
  lines.forEach((text, i) => {
    if (text.trim() === want && (best < 0 || Math.abs(i + 1 - start) < Math.abs(best + 1 - start))) best = i;
  });
  if (best < 0) return "lost";
  const shift = best + 1 - start;
  return { start: start + shift, end: end + shift };
}

const asWritten = (range: NoteRange): Placed | null => (range.lines ? { start: range.lines[0], end: range.lines[1] } : null);

interface Changed {
  ref: LineRef;
  at: number;
  del: boolean;
}

// Each changed line with its line in the new version; a deleted line sits at the line that now follows it.
export function changedLines(file: FileDiff): Changed[] {
  return file.hunks.flatMap((hunk, h) => {
    const out: Changed[] = [];
    let next = hunk.newLines === 0 ? hunk.newStart + 1 : hunk.newStart + hunk.newLines;
    for (let i = hunk.lines.length - 1; i >= 0; i--) {
      const line = hunk.lines[i];
      if (line.kind === "del") out.push({ ref: { hunk: h, line: i }, at: next, del: true });
      else {
        next = line.newNo!;
        if (line.kind === "add") out.push({ ref: { hunk: h, line: i }, at: next, del: false });
      }
    }
    return out.reverse();
  });
}

const covers = (p: Placed | null, c: Changed) => !p || (c.at >= p.start && c.at <= p.end + (c.del ? 1 : 0));

const blank = (file: FileDiff, c: Changed) => !file.hunks[c.ref.hunk].lines[c.ref.line].text.trim();

// A chapter's changed lines in a file. Blank lines no range covers go with the nearest other changed line.
export function chapterRefs(file: FileDiff, mine: (Placed | null)[], all: (Placed | null)[]): LineRef[] {
  const lines = changedLines(file);
  const solid = lines.filter((c) => !blank(file, c));
  const ours = (c: Changed) => mine.some((p) => covers(p, c));
  return lines
    .filter((c) => {
      if (ours(c)) return true;
      if (!blank(file, c) || all.some((p) => covers(p, c))) return false;
      const near = solid.reduce<Changed | null>((best, s) => (!best || Math.abs(s.at - c.at) < Math.abs(best.at - c.at) ? s : best), null);
      return !!near && ours(near);
    })
    .map((c) => c.ref);
}

// Changed lines no chapter covers, by file, where the ranges are now or else as written. Blank lines don't count.
export function uncovered(files: FileDiff[], notes: AgentNotes, placed?: (Placed | "lost" | null)[][]): { path: string; count: number }[] {
  const byPath = new Map<string, (Placed | null)[]>();
  notes.chapters.forEach((c, ci) =>
    c.ranges.forEach((r, ri) => {
      const at = placed?.[ci]?.[ri] ?? asWritten(r);
      if (at !== "lost") byPath.set(r.path, [...(byPath.get(r.path) ?? []), at]);
    }),
  );
  return files.flatMap((file) => {
    const placed = byPath.get(file.path) ?? [];
    const count = changedLines(file).filter((c) => !blank(file, c) && !placed.some((p) => covers(p, c))).length;
    return count ? [{ path: file.path, count }] : [];
  });
}

// A range whose lines are lost counts every change in its file, so a chapter is never taken for done by mistake.
export function hasChanges(files: FileDiff[], chapter: Chapter, placed: (Placed | "lost" | null)[]): boolean {
  return chapter.ranges.some((r, i) => {
    const file = files.find((f) => f.path === r.path);
    const at = placed[i];
    return !!file && (!file.hunks.length || chapterRefs(file, [at === "lost" ? null : at], []).length > 0);
  });
}
