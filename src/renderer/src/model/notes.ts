import { type ChapterTarget, type Placed, targetRefs } from "../../../shared/chapters";
import type { AgentNotes, Chapter, FileContents, FileDiff, Hunk, LineRef, NoteRange } from "../../../shared/types";
import { langFor } from "./lang";
import { keysToGiveLineARow, type Row } from "./rows";

export interface Stop {
  chapter: number;
  range: number;
  step: number;
  joined: boolean;
}

// Only ranges this close share a stop: far ones would go unseen.
const SAME_SCREEN = 30;

// The walk lands on the lead's first line, so what counts is how far below that a range starts.
function sharesStop(lead: NoteRange, r: NoteRange): boolean {
  if (lead.path !== r.path || !lead.lines || !r.lines) return false;
  const below = r.lines[0] - lead.lines[0];
  return below >= 0 && below <= SAME_SCREEN;
}

export function stopsOf(notes: AgentNotes): Stop[] {
  return notes.chapters.flatMap((c, chapter) => {
    let step = 0;
    let lead = c.ranges[0];
    // Without carried notes a step is only a place, so every place gets its own press.
    const narrated = c.carries && c.ranges.some((r) => r.note);
    return c.ranges.map((r, range) => {
      const joined = range > 0 && !r.note && sharesStop(lead, r);
      if (range > 0 && (r.note || (!narrated && !joined))) step++;
      if (!joined) lead = r;
      return { chapter, range, step, joined };
    });
  });
}

const shape = (c: Chapter) => JSON.stringify([c.title, c.ranges.map((r) => r.path)]);

export const shapeOf = (notes: AgentNotes) => notes.chapters.map(shape).join("\n");

// Notes reload mid-walk and a commit drops chapters, so a position only means something against the notes it was taken from.
export function sameStop(before: AgentNotes, after: AgentNotes, index: number): number | null {
  const was = stopsOf(before)[index];
  if (!was) return null;
  const wanted = shape(before.chapters[was.chapter]);
  const stayed = was.chapter < after.chapters.length && shape(after.chapters[was.chapter]) === wanted;
  const chapter = stayed ? was.chapter : after.chapters.findIndex((c) => shape(c) === wanted);
  if (chapter < 0) return null;
  return stopsOf(after).findIndex((s) => s.chapter === chapter && s.range === was.range);
}

export const leadOf = (stops: Stop[], index: number): number => {
  while (index > 0 && stops[index].joined) index--;
  return index;
};

export function nextStop(stops: Stop[], from: number | null, delta: 1 | -1, passes: (stop: Stop, index: number) => boolean): number | null {
  for (let i = from === null ? (delta > 0 ? 0 : stops.length - 1) : from + delta; i >= 0 && i < stops.length; i += delta) {
    if (!stops[i].joined && !passes(stops[i], i)) return i;
  }
  return null;
}

const sameStep = (a: Stop, b: Stop) => a.chapter === b.chapter && a.step === b.step;

export function nextStep(stops: Stop[], from: number | null, delta: 1 | -1, passes: (stop: Stop, index: number) => boolean): number | null {
  const at = from === null ? null : stops[from];
  const found = nextStop(stops, from, delta, (s, i) => passes(s, i) || (at !== null && sameStep(s, at)));
  if (found === null || delta > 0) return found;
  let first = found;
  for (let i = found - 1; i >= 0 && sameStep(stops[i], stops[found]); i--) if (!stops[i].joined && !passes(stops[i], i)) first = i;
  return first;
}

export const stepCount = (stops: Stop[]) => new Set(stops.map((s) => `${s.chapter}:${s.step}`)).size;

export function stepNote(chapter: Chapter, range: number): string | undefined {
  return chapter.carries ? chapter.ranges.slice(0, range + 1).findLast((r) => r.note)?.note : chapter.ranges[range].note;
}

export interface Caption {
  chapter: number;
  chapters: number;
  title: string;
  step: number;
  steps: number;
  place: number;
  places: number;
  sameFile: number;
  text: string;
  warn: boolean;
}

export function captionOf(notes: AgentNotes, stops: Stop[], index: number): Caption {
  const { chapter, range, step } = stops[index];
  const c = notes.chapters[chapter];
  const own = stops.filter((s) => s.chapter === chapter);
  const lead = leadOf(stops, index);
  let sameFile = 1;
  while (stops[lead + sameFile]?.joined) sameFile++;
  const presses = stops.flatMap((s, i) => (s.chapter === chapter && s.step === step && !s.joined ? [i] : []));
  return {
    chapter: chapter + 1,
    chapters: notes.chapters.length,
    title: c.title,
    step: step + 1,
    steps: own[own.length - 1].step + 1,
    place: presses.indexOf(lead) + 1,
    places: presses.length,
    sameFile,
    text: stepNote(c, range) ?? c.text,
    warn: stops.slice(lead, lead + sameFile).some((s) => c.ranges[s.range].warn),
  };
}

export type Skim = "agent" | "whitespace";

// Languages whose only multi-line text is what the checks below look for. Lua, Nix, Ruby, OCaml, SQL and shell each have forms they'd miss.
export const OUTER_SPACE_IS_FREE = new Set([
  "c",
  "cpp",
  "csharp",
  "css",
  "dart",
  "go",
  "java",
  "javascript",
  "json",
  "jsonc",
  "jsx",
  "kotlin",
  "less",
  "rust",
  "scss",
  "swift",
  "tsx",
  "typescript",
]);

// The last form is a backslash ending a line: spaces after it, or before the line it continues, can change what runs.
const MULTILINE_STRING = /`|"""|'''|<<[-~]?[ \t]*["'\\]?[A-Za-z_]|<(?:pre|textarea)\b|\\[ \t\r]*$/im;
const QUOTE = /(?<!\\)"|(?<![\p{L}\p{N}\\])'|'(?![\p{L}\p{N}])/gu;

// Plain quotes can span lines in Rust, shell, Ruby and more, so a line leaving one open rules out the claim.
const leavesQuoteOpen = (text: string) => text.split("\n").some((line) => (line.match(QUOTE)?.length ?? 0) % 2 === 1);

// With nothing to read, a string can't be ruled out.
export const holdsMultilineText = ({ a, b, hidden }: FileContents) =>
  hidden || (a === null && b === null) || [a, b].some((side) => side !== null && (MULTILINE_STRING.test(side) || leavesQuoteOpen(side)));

// Only a line's two ends are compared loosely: spaces inside it can be in a string, and a line break can end a statement.
const bareLine = (text: string) => text.replace(/^[ \t]+|[ \t\r]+$/g, "");

export function whitespaceOnly(targets: ChapterTarget[]): boolean {
  const unchanged = (t: ChapterTarget) => {
    if (t.file.binary || t.file.tooLarge || !t.file.hunks.length || t.file.status === "renamed" || t.file.oldMode !== t.file.newMode) return false;
    if (!OUTER_SPACE_IS_FREE.has(langFor(t.file.path))) return false;
    const refs = targetRefs(t);
    if ([...new Set(refs.map((r) => r.hunk))].some((h) => t.file.hunks[h].lines.some((l) => MULTILINE_STRING.test(l.text)))) return false;
    // Compared block by block, because a line moved past unchanged code leaves the same text in the hunk.
    const blocks: { del: string[]; add: string[] }[] = [];
    let last: LineRef | null = null;
    for (const ref of refs) {
      if (!last || ref.hunk !== last.hunk || ref.line !== last.line + 1) blocks.push({ del: [], add: [] });
      last = ref;
      const { kind, text } = t.file.hunks[ref.hunk].lines[ref.line];
      // Bytes that aren't UTF-8 all decode to this, so two different lines can read the same.
      if (text.includes("\uFFFD")) return false;
      if (bareLine(text)) blocks[blocks.length - 1][kind === "del" ? "del" : "add"].push(bareLine(text));
    }
    return blocks.every((b) => b.del.join("\n") === b.add.join("\n"));
  };
  return targets.length > 0 && targets.every(unchanged);
}

export function skimOf(chapter: Chapter, targets: ChapterTarget[], plainFile: (file: FileDiff) => boolean): Skim | null {
  if (chapter.warn || chapter.ranges.some((r) => r.warn)) return null;
  // A hunk can't show a string opened further up, so the claim needs the whole file.
  if (whitespaceOnly(targets) && targets.every((t) => plainFile(t.file))) return "whitespace";
  return chapter.skim ? "agent" : null;
}

export function firstStopLeft(notes: AgentNotes, stops: Stop[], chapter: number, staged: ReadonlyMap<number, "full" | "partial">, shown: ReadonlySet<string>) {
  const left = stops.findIndex((s, i) => s.chapter === chapter && staged.get(i) !== "full" && shown.has(notes.chapters[chapter].ranges[s.range].path));
  return left >= 0 ? left : stops.findIndex((s) => s.chapter === chapter);
}

export interface Check {
  stop: number;
  title: string;
  text: string;
}

export function checksOf(notes: AgentNotes, stops: Stop[]): Check[] {
  return stops.flatMap(({ chapter, range }, stop) => {
    const c = notes.chapters[chapter];
    const r = c.ranges[range];
    if (r.warn) return [{ stop, title: c.title, text: stepNote(c, range) ?? c.text }];
    return c.warn && range === 0 ? [{ stop, title: c.title, text: c.text }] : [];
  });
}

export function newLineOf(row: Row): number | undefined {
  if (row.t === "split") return row.b?.no;
  return row.t === "uni" && row.kind !== "del" ? row.b : undefined;
}

export function rowOfLine(rows: Row[], line: number): number {
  return rows.findIndex((r) => newLineOf(r) === line);
}

const deleted = (row: Row | undefined) => !!row && (row.t === "uni" || row.t === "split") && newLineOf(row) === undefined;

// Enough of a deletion to see what went, while the noted line stays on a short screen.
const DELETED_ROWS_SHOWN = 10;

// Deleted rows sit above the line that follows them, and they're what a step about a deletion is for.
export function rowToShow(rows: Row[], index: number): number {
  const floor = index - DELETED_ROWS_SHOWN;
  while (index > floor && deleted(rows[index - 1])) index--;
  return index;
}

// The nearest hunk at or below a range, and whether it's inside it.
export function hunkAt(hunks: Hunk[], { start, end }: Placed): { hunk: number; inside: boolean; below: boolean } {
  const first = (h: Hunk) => (h.newLines ? h.newStart : h.newStart + 1);
  const at = hunks.findIndex((h) => first(h) + Math.max(h.newLines, 1) > start);
  return at < 0 ? { hunk: hunks.length - 1, inside: false, below: true } : { hunk: at, inside: first(hunks[at]) <= end, below: false };
}

// The shortest ending of each path that tells it from the others, so register.ts in ten folders reads apart.
export function shortNames(paths: string[]): Map<string, string> {
  const out = new Map<string, string>();
  let left = [...new Set(paths)].map((path) => ({ path, parts: path.split("/") }));
  for (let n = 1; left.length; n++) {
    const byEnding = new Map<string, typeof left>();
    for (const p of left) {
      const name = p.parts.slice(-n).join("/");
      const same = byEnding.get(name);
      if (same) same.push(p);
      else byEnding.set(name, [p]);
    }
    left = [...byEnding].flatMap(([name, same]) => {
      const [done, rest] = same.length === 1 ? [same, []] : [same.filter((p) => p.parts.length <= n), same.filter((p) => p.parts.length > n)];
      done.forEach((p) => out.set(p.path, name));
      return rest;
    });
  }
  return out;
}

export function lineKeys(rows: Row[], hunks: Hunk[], line: number): string[] {
  return keysToGiveLineARow(rows, line, (hunk) => line >= hunks[hunk].newStart && line < hunks[hunk].newStart + hunks[hunk].newLines);
}

export interface Mark extends Placed {
  chapter: number;
  stop: number;
  lead: number;
  title: string;
}

export interface RowNote {
  mark: Mark;
  cls: string;
  first: boolean;
}

export function rowNotes(rows: Row[], marks: Mark[], chapter: number | null, stop: number | null): (RowNote | null)[] {
  const rank = (m: Mark) => (m.lead === stop ? 2 : m.chapter === chapter ? 1 : 0);
  const picked: (Mark | null)[] = [];
  const pastEnd: number[] = [];
  let line: number | undefined;
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    // A deleted line has no new number, so it joins the line that follows it.
    line = row.t === "uni" || row.t === "split" ? (newLineOf(row) ?? line) : undefined;
    const at = line;
    if (at === undefined && deleted(row)) pastEnd.unshift(i);
    picked[i] =
      at === undefined ? null : marks.filter((m) => at >= m.start && at <= m.end).reduce<Mark | null>((a, b) => (a && rank(a) >= rank(b) ? a : b), null);
  }
  for (const i of pastEnd) picked[i] = picked[i - 1] ?? null;
  return picked.map((mark, i) => {
    if (!mark) return null;
    const r = rank(mark);
    const first = picked[i - 1]?.stop !== mark.stop;
    const last = picked[i + 1]?.stop !== mark.stop;
    return { mark, first, cls: `noted${r > 0 ? " in-chapter" : ""}${r === 2 ? " note-now" : ""}${first ? " noted-top" : ""}${last ? " noted-bot" : ""}` };
  });
}

export function noteSpans(text: string): { code: boolean; text: string }[] {
  return text.split(/`([^`\n]+)`/).flatMap((part, i) => (part ? [{ code: i % 2 === 1, text: part }] : []));
}
