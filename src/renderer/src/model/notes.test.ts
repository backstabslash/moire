import { describe, expect, it } from "vitest";
import type { FileDiff } from "../../../shared/types";
import { chapterFile, chapterHunks, chapterText } from "../../../main/test-repo";
import { lineKeys, noteSpans, rowNotes, rowOfLine, stopsOf } from "./notes";
import { buildRows, type Row } from "./rows";

describe("stopsOf", () => {
  it("lists every range of every chapter in order", () => {
    const range = { path: "a.ts" };
    const notes = {
      chapters: [
        { title: "A", text: "", ranges: [range, range] },
        { title: "B", text: "", ranges: [range] },
      ],
    };
    expect(stopsOf(notes)).toEqual([
      { chapter: 0, range: 0 },
      { chapter: 0, range: 1 },
      { chapter: 1, range: 0 },
    ]);
  });
});
describe("rows for a range", () => {
  const one: FileDiff = { ...chapterFile, hunks: [chapterHunks[0]] };
  const contents = { a: chapterText.join("\n"), b: chapterText.with(9, "line ten").join("\n"), hidden: false };

  it("finds changed lines and the fold hiding context lines", () => {
    for (const layout of ["split", "unified"] as const) {
      const rows = buildRows(one, contents, { layout, scope: "changed", expanded: new Set() });
      expect(rows[rowOfLine(rows, 10)]).toMatchObject({ kind: layout === "split" ? "chg" : "add" });
      expect(rowOfLine(rows, 25)).toBe(-1);
      expect(lineKeys(rows, one.hunks, 25)).toEqual(["gap1"]);
      const open = buildRows(one, contents, { layout, scope: "changed", expanded: new Set(["gap1"]) });
      expect(rowOfLine(open, 25)).toBeGreaterThan(0);
    }
  });
});

describe("rowNotes", () => {
  const marks = [
    { chapter: 0, stop: 0, title: "One", start: 3, end: 8 },
    { chapter: 1, stop: 1, title: "Two", start: 5, end: 5 },
    { chapter: 1, stop: 2, title: "Two", start: 7, end: 9 },
  ];
  const line = (b: number) => ({ t: "uni", kind: "ctx", b }) as Row;
  const del = { t: "uni", kind: "del" } as Row;
  const head = { t: "hunk" } as Row;
  const classes = (rows: Row[], chapter: number | null, stop: number | null) => rowNotes(rows, marks, chapter, stop).map((n) => n?.cls ?? "");

  it("prefers the current stop, then its chapter", () => {
    const rows = [2, 3, 4, 5, 6].map(line);
    expect(classes(rows, null, null)).toEqual(["", "noted noted-top", "noted", "noted", "noted noted-bot"]);
    expect(classes(rows, 1, 1)[3]).toBe("noted in-chapter note-now noted-top noted-bot");
    expect(classes(rows, 0, 0)[3]).toBe("noted in-chapter note-now");
  });

  it("carries deleted lines into the range of the line after them", () => {
    const notes = rowNotes([line(3), del, line(4), del, line(10)], marks, null, null);
    expect(notes.map((n) => n?.mark.stop ?? null)).toEqual([0, 0, 0, null, null]);
    expect(notes.map((n) => n?.first ?? false)).toEqual([true, false, false, false, false]);
  });

  it("numbers each visible piece of a range", () => {
    const notes = rowNotes([line(3), line(4), head, line(6)], marks, null, null);
    expect(notes.map((n) => n?.first ?? null)).toEqual([true, false, null, true]);
  });
});

describe("noteSpans", () => {
  it("splits inline code out of the text", () => {
    expect(noteSpans("Calls `fetch` twice, see `retry()`.")).toEqual([
      { code: false, text: "Calls " },
      { code: true, text: "fetch" },
      { code: false, text: " twice, see " },
      { code: true, text: "retry()" },
      { code: false, text: "." },
    ]);
  });
});
