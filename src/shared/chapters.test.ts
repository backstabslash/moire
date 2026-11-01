import { describe, expect, it } from "vitest";
import { changedLines, chapterRefs, chapterSize, hasChanges, placeRange, rangeStaged, uncovered } from "./chapters";
import { chapterFile as file, chapterHunks as hunks, chapterText as text, diffHunk } from "../main/test-repo";
import type { FileDiff, Placement } from "./types";

describe("chapterSize", () => {
  it("counts changed lines that aren't blank", () => {
    const blank = { ...file, hunks: [diffHunk(1, ["+", "+code", " ctx", "-old"])] };
    expect(chapterSize([{ file: blank, lines: null }])).toBe(2);
    expect(
      chapterSize([
        { file: blank, lines: [{ hunk: 0, line: 1 }] },
        { file, lines: null },
      ]),
    ).toBe(5);
  });
});

describe("placeRange", () => {
  it("keeps line numbers when the code still matches or wasn't given", () => {
    expect(placeRange({ path: "a", lines: [4, 6], code: "  line 4" }, text)).toEqual({ start: 4, end: 6 });
    expect(placeRange({ path: "a", lines: [4, 6] }, text)).toEqual({ start: 4, end: 6 });
    expect(placeRange({ path: "a" }, text)).toBe("all");
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

describe("chapters and coverage", () => {
  const removed: FileDiff = { ...file, hunks: [diffHunk(4, [" a", " b", "-checkAuth();", " c"])] };

  it("places deleted lines at the line that now follows them", () => {
    expect(changedLines(file).map((c) => [c.newLine, c.del])).toEqual([
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
    expect(chapterRefs(file, ["all"], ["all"])).toHaveLength(4);
  });

  it("leaves a deletion to the line after it, so a chapter can't take half of a replaced line", () => {
    const replaced: FileDiff = { ...file, hunks: [diffHunk(4, [" a", " b", "-timeout = 30", "+timeout = 300", " c"])] };
    const above = { start: 3, end: 5 };
    const notes = { chapters: [{ title: "T", text: "", ranges: [{ path: "a.ts", lines: [3, 5] as [number, number] }] }] };
    expect(chapterRefs(replaced, [above], [above])).toEqual([]);
    expect(chapterRefs(removed, [above], [above])).toEqual([]);
    expect(uncovered([removed], notes)).toEqual([{ path: "a.ts", count: 1 }]);
    expect(chapterRefs(removed, [{ start: 6, end: 6 }], [])).toEqual([{ hunk: 0, line: 2 }]);
  });

  it("finishes a chapter when another chapter explains the deletion below it", () => {
    const ranges = [{ path: "a.ts", lines: [3, 5] as [number, number] }];
    const every = new Map([
      [
        "a.ts",
        [
          { start: 3, end: 5 },
          { start: 6, end: 6 },
        ],
      ],
    ]);
    expect(hasChanges([removed], { title: "T", text: "", ranges }, [{ start: 3, end: 5 }], every)).toBe(false);
  });

  it("keeps a chapter ending just above a deletion, though the deletion stays unexplained", () => {
    const ranges = [{ path: "a.ts", lines: [3, 5] as [number, number] }];
    expect(hasChanges([removed], { title: "T", text: "", ranges }, [{ start: 3, end: 5 }], new Map())).toBe(true);
    expect(hasChanges([removed], { title: "T", text: "", ranges }, [{ start: 3, end: 4 }], new Map())).toBe(false);
  });

  it("lets a range reach a deletion at the end of the file, which has no line after it", () => {
    const tail: FileDiff = { ...file, hunks: [diffHunk(4, [" a", " b", "-gone"])] };
    expect(chapterRefs(tail, [{ start: 5, end: 5 }], [])).toEqual([{ hunk: 0, line: 2 }]);
  });

  it("gives blank lines no range covers to the chapter of the nearest changed line", () => {
    const spaced: FileDiff = { ...file, hunks: [diffHunk(4, ["+x", "+"], 5), diffHunk(9, ["+"], 12), diffHunk(10, ["+y"], 14)] };
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
    expect(uncovered([file], notes, [[{ start: 24, end: 25 }, "all"]])).toEqual([{ path: "a.ts", count: 3 }]);
    expect(uncovered([file], notes, [["lost", "all"]])).toEqual([{ path: "a.ts", count: 4 }]);
    const placed: Placement[] = [{ start: 10, end: 12 }, "all"];
    expect(hasChanges([file], notes.chapters[0], placed, new Map())).toBe(true);
    expect(hasChanges([other], notes.chapters[0], placed, new Map())).toBe(false);
    expect(hasChanges([file], notes.chapters[0], [{ start: 40, end: 41 }, "all"], new Map())).toBe(false);
    expect(hasChanges([file], notes.chapters[0], ["lost", "all"], new Map())).toBe(true);
  });
});

describe("rangeStaged", () => {
  const at = (start: number, end: number) => ({ start, end });

  it("in the unstaged view, finds a range's index lines among those staged earlier", () => {
    const earlier: FileDiff = { ...file, alreadyStaged: { stagedRanges: [[3, 4]], deletionsAfter: [22] } };
    expect(rangeStaged(earlier, at(1, 5), "unstaged")).toBe("full");
    expect(rangeStaged(earlier, at(2, 10), "unstaged")).toBe("partial");
    expect(rangeStaged(earlier, at(9, 11), "unstaged")).toBeNull();
    expect(rangeStaged(earlier, at(21, 21), "unstaged")).toBe("full");
    expect(rangeStaged(earlier, "all", "unstaged")).toBe("partial");
    expect(rangeStaged(file, at(1, 5), "unstaged")).toBeNull();
    expect(rangeStaged(earlier, at(1, 1_000_000), "unstaged")).toBe(rangeStaged(earlier, at(1, 30), "unstaged"));
  });

  it("in the All view, counts the staged marks on the range's changed lines", () => {
    const marked: FileDiff = { ...file, hunks: [{ ...hunks[0], lines: hunks[0].lines.map((l) => ({ ...l, staged: true })) }, ...hunks.slice(1)] };
    expect(rangeStaged(marked, at(10, 10), "all")).toBe("full");
    expect(rangeStaged(marked, at(9, 20), "all")).toBe("partial");
    expect(rangeStaged(marked, at(25, 25), "all")).toBeNull();
  });
});
