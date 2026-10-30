import { describe, expect, it } from "vitest";
import type { FileDiff } from "../../../shared/types";
import { chapterFile, chapterHunks, chapterText } from "../../../main/test-repo";
import { lineKeys, noteClass, noteSpans, rowOfLine, stopsOf } from "./notes";
import { buildRows } from "./rows";

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

describe("noteClass", () => {
  const marks = [
    { chapter: 0, stop: 0, start: 3, end: 8 },
    { chapter: 1, stop: 1, start: 5, end: 5 },
    { chapter: 1, stop: 2, start: 7, end: 9 },
  ];
  it("brackets chapter lines and prefers the current stop, then its chapter", () => {
    expect(noteClass(2, marks, null, null)).toBe("");
    expect(noteClass(3, marks, null, null)).toBe("noted noted-top");
    expect(noteClass(5, marks, 1, 1)).toBe("noted in-chapter note-now noted-top noted-bot");
    expect(noteClass(8, marks, 1, 1)).toBe("noted in-chapter");
    expect(noteClass(8, marks, 0, 0)).toBe("noted in-chapter note-now noted-bot");
    expect(noteClass(undefined, marks, 0, 0)).toBe("");
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
