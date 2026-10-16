import { describe, expect, it } from "vitest";
import { changedLines, chapterRefs, hasChanges, placeRange, uncovered } from "./chapters";
import type { FileDiff, Hunk } from "./types";

const text = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);

describe("placeRange", () => {
  it("keeps line numbers when the code still matches or wasn't given", () => {
    expect(placeRange({ path: "a", lines: [4, 6], code: "  line 4" }, text)).toEqual({ start: 4, end: 6 });
    expect(placeRange({ path: "a", lines: [4, 6] }, text)).toEqual({ start: 4, end: 6 });
    expect(placeRange({ path: "a" }, text)).toBeNull();
  });

  it("follows its first line to the nearest match when lines moved", () => {
    const moved = ["new", "new", ...text];
    expect(placeRange({ path: "a", lines: [4, 6], code: "line 4" }, moved)).toEqual({ start: 6, end: 8 });
  });

  it("finds its code even when the file is now shorter than where it was", () => {
    expect(placeRange({ path: "a", lines: [28, 29], code: "line 18" }, text.slice(0, 20))).toEqual({ start: 18, end: 19 });
  });

  it("is lost when its first line is gone", () => {
    expect(placeRange({ path: "a", lines: [4, 4], code: "deleted line" }, text)).toBe("lost");
    expect(placeRange({ path: "a", lines: [40, 41] }, text)).toBe("lost");
  });
});

// Line 10 replaced, line 20 deleted, a line added after 25.
const hunks: Hunk[] = [
  {
    oldStart: 10,
    oldLines: 1,
    newStart: 10,
    newLines: 1,
    header: "",
    lines: [
      { kind: "del", text: "line 10", oldNo: 10 },
      { kind: "add", text: "line ten", newNo: 10 },
    ],
  },
  { oldStart: 20, oldLines: 1, newStart: 19, newLines: 0, header: "", lines: [{ kind: "del", text: "line 20", oldNo: 20 }] },
  { oldStart: 25, oldLines: 0, newStart: 25, newLines: 1, header: "", lines: [{ kind: "add", text: "extra", newNo: 25 }] },
];
const file: FileDiff = { path: "a.ts", status: "modified", binary: false, additions: 2, deletions: 2, hunks };

describe("chapters and coverage", () => {
  it("places deleted lines at the line that now follows them", () => {
    expect(changedLines(file).map((c) => [c.at, c.del])).toEqual([
      [10, true],
      [10, false],
      [20, true],
      [25, false],
    ]);
  });

  it("picks the changed lines a chapter covers, for staging it", () => {
    const ten = { start: 10, end: 10 };
    expect(chapterRefs(file, [ten], [ten])).toEqual([
      { hunk: 0, line: 0 },
      { hunk: 0, line: 1 },
    ]);
    expect(chapterRefs(file, [{ start: 19, end: 19 }], [])).toEqual([{ hunk: 1, line: 0 }]);
    expect(chapterRefs(file, [null], [null])).toHaveLength(4);
  });

  it("gives blank lines no range covers to the chapter of the nearest changed line", () => {
    const add = (newNo: number, text: string) => ({ kind: "add" as const, text, newNo });
    const spaced: FileDiff = {
      ...file,
      hunks: [
        { oldStart: 4, oldLines: 0, newStart: 5, newLines: 2, header: "", lines: [add(5, "x"), add(6, "")] },
        { oldStart: 9, oldLines: 0, newStart: 12, newLines: 1, header: "", lines: [add(12, "")] },
        { oldStart: 10, oldLines: 0, newStart: 14, newLines: 1, header: "", lines: [add(14, "y")] },
      ],
    };
    const [a, b] = [
      { start: 5, end: 5 },
      { start: 14, end: 14 },
    ];
    expect(chapterRefs(spaced, [a], [a, b])).toEqual([
      { hunk: 0, line: 0 },
      { hunk: 0, line: 1 },
    ]);
    expect(chapterRefs(spaced, [b], [a, b])).toEqual([
      { hunk: 1, line: 0 },
      { hunk: 2, line: 0 },
    ]);
  });

  it("counts changed lines no chapter covers", () => {
    const other: FileDiff = { ...file, path: "b.ts" };
    const notes = { chapters: [{ title: "T", text: "", ranges: [{ path: "a.ts", lines: [10, 12] as [number, number] }, { path: "c.ts" }] }] };
    expect(uncovered([file, other], notes)).toEqual([
      { path: "a.ts", count: 2 },
      { path: "b.ts", count: 4 },
    ]);
    const blank: FileDiff = { ...file, path: "d.ts", hunks: [{ ...hunks[2], lines: [{ kind: "add", text: "  ", newNo: 25 }] }] };
    expect(uncovered([blank], notes)).toEqual([]);
    expect(uncovered([file], notes, [[{ start: 24, end: 25 }, null]])).toEqual([{ path: "a.ts", count: 3 }]);
    expect(uncovered([file], notes, [["lost", null]])).toEqual([{ path: "a.ts", count: 4 }]);
    const placed = [{ start: 10, end: 12 }, null];
    expect(hasChanges([file], notes.chapters[0], placed)).toBe(true);
    expect(hasChanges([other], notes.chapters[0], placed)).toBe(false);
    expect(hasChanges([file], notes.chapters[0], [{ start: 40, end: 41 }, null])).toBe(false);
    expect(hasChanges([file], notes.chapters[0], ["lost", null])).toBe(true);
  });
});
