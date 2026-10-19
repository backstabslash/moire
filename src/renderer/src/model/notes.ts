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
}

export function noteClass(line: number | undefined, marks: Mark[], chapter: number | null, stop: number | null): string {
  if (line === undefined) return "";
  let best: Mark | null = null;
  let rank = -1;
  for (const m of marks) {
    if (line < m.start || line > m.end) continue;
    const r = m.stop === stop ? 2 : m.chapter === chapter ? 1 : 0;
    if (r > rank) [best, rank] = [m, r];
  }
  if (!best) return "";
  return `noted${rank > 0 ? " in-chapter" : ""}${rank === 2 ? " note-now" : ""}${line === best.start ? " noted-top" : ""}${line === best.end ? " noted-bot" : ""}`;
}

export function noteSpans(text: string): { code: boolean; text: string }[] {
  return text.split(/`([^`\n]+)`/).flatMap((part, i) => (part ? [{ code: i % 2 === 1, text: part }] : []));
}
