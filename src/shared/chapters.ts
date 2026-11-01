import type { AgentNotes, Chapter, FileDiff, Hunk, LineRef, NoteRange, Placement } from "./types";

export interface Placed {
  start: number;
  end: number;
}

export function placeRange(range: NoteRange, lines: string[] | null): Placement {
  if (!range.lines) return "all";
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

const asWritten = (range: NoteRange): Placed | "all" => (range.lines ? { start: range.lines[0], end: range.lines[1] } : "all");

const lostAsAll = (p: Placement): Placed | "all" => (p === "lost" ? "all" : p);

interface Changed {
  ref: LineRef;
  newLine: number;
  del: boolean;
  atEnd: boolean;
}

export function changedLines(file: FileDiff): Changed[] {
  return file.hunks.flatMap((hunk, h) => {
    const out: Changed[] = [];
    let next = hunk.newLines === 0 ? hunk.newStart + 1 : hunk.newStart + hunk.newLines;
    let atEnd = true;
    for (let i = hunk.lines.length - 1; i >= 0; i--) {
      const line = hunk.lines[i];
      if (line.kind === "del") out.push({ ref: { hunk: h, line: i }, newLine: next, del: true, atEnd });
      else {
        atEnd = false;
        next = line.newNo!;
        if (line.kind === "add") out.push({ ref: { hunk: h, line: i }, newLine: next, del: false, atEnd: false });
      }
    }
    return out.reverse();
  });
}

// A deletion belongs to the line after it, so a replaced line can't be half taken. End of file has no such line.
const covers = (p: Placed | "all", c: Changed) => p === "all" || (c.newLine >= p.start && c.newLine <= p.end + (c.atEnd ? 1 : 0));

const blank = (file: FileDiff, c: Changed) => !file.hunks[c.ref.hunk].lines[c.ref.line].text.trim();

interface Scan {
  lines: Changed[];
  isBlank: boolean[];
  nearestSolid: (Changed | null)[];
}

const scans = new WeakMap<Hunk[], Scan>();

function scan(file: FileDiff): Scan {
  const cached = scans.get(file.hunks);
  if (cached) return cached;
  const lines = changedLines(file);
  const isBlank = lines.map((c) => blank(file, c));
  const solid = lines.map((c, i) => ({ c, i })).filter((s) => !isBlank[s.i]);
  solid.sort((x, y) => x.c.newLine - y.c.newLine || x.i - y.i);
  const groupStart: number[] = [];
  solid.forEach((s, k) => groupStart.push(k > 0 && solid[k - 1].c.newLine === s.c.newLine ? groupStart[k - 1] : k));
  const nearestSolid = lines.map((c, i) => {
    if (!isBlank[i] || !solid.length) return null;
    let [lo, hi] = [0, solid.length];
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (solid[mid].c.newLine < c.newLine) lo = mid + 1;
      else hi = mid;
    }
    const after = solid[lo];
    const before = lo > 0 ? solid[groupStart[lo - 1]] : undefined;
    if (!before || !after) return (before ?? after)!.c;
    const [db, da] = [c.newLine - before.c.newLine, after.c.newLine - c.newLine];
    return db < da || (db === da && before.i < after.i) ? before.c : after.c;
  });
  const out = { lines, isBlank, nearestSolid };
  scans.set(file.hunks, out);
  return out;
}

export interface ChapterTarget {
  file: FileDiff;
  lines: LineRef[] | null;
}

export const targetRefs = ({ file, lines }: ChapterTarget) => lines ?? changedLines(file).map((c) => c.ref);

export function chapterSize(targets: ChapterTarget[]): number {
  return targets.reduce((n, t) => n + targetRefs(t).filter((r) => t.file.hunks[r.hunk].lines[r.line].text.trim()).length, 0);
}

export function chapterRefs(file: FileDiff, chapterRanges: (Placed | "all")[], everyChapterRanges: (Placed | "all")[]): LineRef[] {
  const { lines, isBlank, nearestSolid } = scan(file);
  const ours = (c: Changed) => chapterRanges.some((p) => covers(p, c));
  return lines
    .filter((c, i) => {
      if (ours(c)) return true;
      if (!isBlank[i] || everyChapterRanges.some((p) => covers(p, c))) return false;
      return !!nearestSolid[i] && ours(nearestSolid[i]);
    })
    .map((c) => c.ref);
}

function uncoveredLines(files: FileDiff[], notes: AgentNotes, placed?: Placement[][]) {
  const byPath = new Map<string, (Placed | "all")[]>();
  notes.chapters.forEach((c, ci) =>
    c.ranges.forEach((r, ri) => {
      const at = placed?.[ci]?.[ri] ?? asWritten(r);
      if (at !== "lost") byPath.set(r.path, [...(byPath.get(r.path) ?? []), at]);
    }),
  );
  return files.map((file) => {
    const placed = byPath.get(file.path) ?? [];
    const { lines, isBlank } = scan(file);
    // A binary, chmod-only or oversized file has no lines to count, but still hasn't been explained.
    return { path: file.path, left: lines.filter((c, i) => !isBlank[i] && !placed.some((p) => covers(p, c))), lineless: !file.hunks.length && !placed.length };
  });
}

export function uncovered(files: FileDiff[], notes: AgentNotes, placed?: Placement[][]): { path: string; count: number }[] {
  return uncoveredLines(files, notes, placed).flatMap(({ path, left, lineless }) => (left.length || lineless ? [{ path, count: left.length }] : []));
}

export const firstUncovered = (file: FileDiff, notes: AgentNotes, placed?: Placement[][]) => uncoveredLines([file], notes, placed)[0].left[0]?.newLine ?? null;

// Older notes can end just above a deletion. It stays unexplained, but a chapter that close isn't finished, unless another chapter explains it.
export const bordersDeletion = (file: FileDiff, at: Placed | "all", every: (Placed | "all")[]) =>
  at !== "all" && scan(file).lines.some((c) => c.del && c.newLine === at.end + 1 && !every.some((p) => covers(p, c)));

export function placesByPath(chapters: Pick<Chapter, "ranges">[], placed: Placement[][]): Map<string, (Placed | "all")[]> {
  const out = new Map<string, (Placed | "all")[]>();
  chapters.forEach((c, ci) =>
    c.ranges.forEach((r, ri) => {
      const at = placed[ci]?.[ri];
      if (at && at !== "lost") out.set(r.path, [...(out.get(r.path) ?? []), at]);
    }),
  );
  return out;
}

function rangeHasChanges(files: FileDiff[], r: NoteRange, placed: Placement, every: ReadonlyMap<string, (Placed | "all")[]>): boolean {
  const file = files.find((f) => f.path === r.path);
  if (!file) return false;
  const at = lostAsAll(placed);
  return !file.hunks.length || chapterRefs(file, [at], []).length > 0 || bordersDeletion(file, at, every.get(r.path) ?? []);
}

export function hasChanges(files: FileDiff[], chapter: Chapter, placed: Placement[], every: ReadonlyMap<string, (Placed | "all")[]>): boolean {
  return chapter.ranges.some((r, i) => rangeHasChanges(files, r, placed[i], every));
}

// A warning can be about lines nobody changed, which staging can never finish, so it has to be told from one on lines already staged.
export function standingWarns(files: FileDiff[], chapters: Chapter[], placed: Placement[][]): number[][] {
  const every = placesByPath(chapters, placed);
  return chapters.map((c, ci) => {
    const quiet = c.ranges.map((r, i) => !rangeHasChanges(files, r, placed[ci][i], every));
    return c.ranges.flatMap((r, i) => (quiet[i] && (r.warn || (c.warn && quiet.every(Boolean))) ? [i] : []));
  });
}

// Hunks here have no context lines, so each one is exactly the lines that changed.
function carryLine(hunks: Hunk[], n: number, edge: "start" | "end"): number {
  let delta = 0;
  for (const h of hunks) {
    const first = h.oldLines === 0 ? h.oldStart + 1 : h.oldStart;
    const newFirst = h.newLines === 0 ? h.newStart + 1 : h.newStart;
    if (n < first) break;
    if (n < first + h.oldLines) return edge === "start" ? newFirst : newFirst + h.newLines - 1;
    delta = newFirst + h.newLines - first - h.oldLines;
  }
  return n + delta;
}

export function carryLines(hunks: Hunk[], [start, end]: [number, number]): [number, number] | null {
  const [from, to] = [carryLine(hunks, start, "start"), carryLine(hunks, end, "end")];
  return from > to ? null : [from, to];
}

// A later edit beside a deletion isn't explained by it, so the note moves to the line above, which borders the deletion and claims nothing.
export function carryDeletion(later: Hunk[], before: number, lastLine: number): [number, number] {
  const after = before + 1;
  const disturbed = later.some((h) => (h.oldLines ? h.oldStart <= after && after < h.oldStart + h.oldLines : h.oldStart === before));
  const line = Math.max(1, carryLine(later, Math.max(1, !disturbed && after <= lastLine ? after : before), "end"));
  return [line, line];
}

export function carryRegions(own: Hunk[], later: Hunk[], lastLine: number): [number, number][] {
  return own.flatMap((h) => {
    if (!h.newLines) return [carryDeletion(later, h.newStart, lastLine)];
    const lines = carryLines(later, [h.newStart, h.newStart + h.newLines - 1]);
    return lines ? [lines] : [];
  });
}

export function newToOld(hunks: Hunk[]): (n: number) => number | null {
  return (n) => {
    let delta = 0;
    for (const h of hunks) {
      const first = h.newLines === 0 ? h.newStart + 1 : h.newStart;
      if (n < first) break;
      if (n < first + h.newLines) {
        const line = h.lines.find((l) => l.newNo === n);
        return line?.kind === "ctx" ? line.oldNo! : null;
      }
      delta = (h.oldLines === 0 ? h.oldStart + 1 : h.oldStart) + h.oldLines - first - h.newLines;
    }
    return n + delta;
  };
}

export function rangeStaged(file: FileDiff, at: Placed | "all", view: "unstaged" | "all"): "full" | "partial" | null {
  const refs = chapterRefs(file, [at], [at]);
  if (view === "all") {
    const staged = refs.filter((r) => file.hunks[r.hunk].lines[r.line].staged).length;
    return !staged ? null : staged === refs.length ? "full" : "partial";
  }
  const done = file.alreadyStaged;
  if (!done) return null;
  let staged = at === "all" && (done.stagedRanges.length > 0 || done.deletionsAfter.length > 0);
  if (at !== "all") {
    const toIndex = newToOld(file.hunks);
    let [lo, hi]: (number | null)[] = [null, null];
    for (let n = at.start; lo === null && n <= at.end; n++) lo = toIndex(n);
    for (let n = at.end; hi === null && n >= at.start; n--) hi = toIndex(n);
    staged = lo !== null && hi !== null && (done.stagedRanges.some(([a, b]) => a <= hi && b >= lo) || done.deletionsAfter.some((k) => k >= lo - 1 && k <= hi));
  }
  return !staged ? null : refs.length ? "partial" : "full";
}
