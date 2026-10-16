import type { Placed } from "../../../shared/chapters";
import type { AgentNotes, Hunk } from "../../../shared/types";
import type { Row } from "./rows";

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

// The fold or folded-hunk keys to expand so the line gets a row.
export function lineKeys(rows: Row[], hunks: Hunk[], line: number): string[] {
  const covers = (from: number, count: number) => line >= from && line < from + count;
  return rows.flatMap((r) =>
    r.t === "fold" && covers(r.newFrom, r.count)
      ? [r.key]
      : r.t === "hunk" && r.folded && (covers(hunks[r.hunk].newStart, hunks[r.hunk].newLines) || r.folded.gaps.some(([from, count]) => covers(from, count)))
        ? r.folded.keys
        : [],
  );
}

export interface Mark extends Placed {
  chapter: number;
  stop: number;
}

// Row classes for the gutter bracket beside a chapter's lines; the current stop's lines are also tinted.
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
