import type { Placed } from "../../../shared/chapters";
import type { AgentNotes, Hunk } from "../../../shared/types";
import { keysToGiveLineARow, type Row } from "./rows";

export interface Stop {
  chapter: number;
  range: number;
}

export function stopsOf(notes: AgentNotes): Stop[] {
  return notes.chapters.flatMap((c, chapter) => c.ranges.map((_, range) => ({ chapter, range })));
}

export function newLineOf(row: Row): number | undefined {
  if (row.t === "split") return row.b?.no;
  return row.t === "uni" && row.kind !== "del" ? row.b : undefined;
}

export function rowOfLine(rows: Row[], line: number): number {
  return rows.findIndex((r) => newLineOf(r) === line);
}

export function lineKeys(rows: Row[], hunks: Hunk[], line: number): string[] {
  return keysToGiveLineARow(rows, line, (hunk) => line >= hunks[hunk].newStart && line < hunks[hunk].newStart + hunks[hunk].newLines);
}

export interface Mark extends Placed {
  chapter: number;
  stop: number;
  title: string;
}

export interface RowNote {
  mark: Mark;
  cls: string;
  first: boolean;
}

export function rowNotes(rows: Row[], marks: Mark[], chapter: number | null, stop: number | null): (RowNote | null)[] {
  const rank = (m: Mark) => (m.stop === stop ? 2 : m.chapter === chapter ? 1 : 0);
  const picked: (Mark | null)[] = [];
  let line: number | undefined;
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    // A deleted line has no new number, so it joins the line that follows it.
    line = row.t === "uni" || row.t === "split" ? (newLineOf(row) ?? line) : undefined;
    const at = line;
    picked[i] =
      at === undefined ? null : marks.filter((m) => at >= m.start && at <= m.end).reduce<Mark | null>((a, b) => (a && rank(a) >= rank(b) ? a : b), null);
  }
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
