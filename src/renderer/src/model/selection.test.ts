import { describe, expect, it } from "vitest";
import type { DiffLine, FileDiff } from "../../../shared/types";
import { buildRows } from "./rows";
import { carryKeys, gapKey, hunkOfKey, isPicked, lineKey } from "./selection";

const opts = { layout: "split" as const, scope: "changed" as const, expanded: new Set<string>() };

function file(...hunks: [number, DiffLine[]][]): FileDiff {
  return {
    path: "a.ts",
    status: "modified",
    binary: false,
    additions: 0,
    deletions: 0,
    hunks: hunks.map(([start, lines]) => ({ oldStart: start, oldLines: 0, newStart: start, newLines: 0, header: "", lines })),
  };
}

const ctx = (text: string, no: number, shift = 0): DiffLine => ({ kind: "ctx", text, oldNo: no, newNo: no + shift });
const add = (text: string, no: number): DiffLine => ({ kind: "add", text, newNo: no });
const del = (text: string, no: number): DiffLine => ({ kind: "del", text, oldNo: no });

const before = file([10, [ctx("}", 10), del("a = 1", 11), add("a = 2", 11), ctx("}", 12)]]);
const after = file([1, [add("// new", 1), ctx("x", 1, 1)]], [10, [ctx("}", 10, 1), del("a = 1", 11), add("a = 2", 12), ctx("}", 12, 1)]]);
const rows = (f: FileDiff) => buildRows(f, null, opts);

describe("carryKeys", () => {
  it("follows selected lines to their new place when lines are added above", () => {
    expect(carryKeys(rows(before), rows(after), new Set(["0:1", "0:2", "0:3"]))).toEqual(
      new Map([
        ["0:1", "1:1"],
        ["0:2", "1:2"],
        ["0:3", "1:3"],
      ]),
    );
  });

  it("tells repeated lines apart by where they were", () => {
    expect(carryKeys(rows(before), rows(after), new Set(["0:0", "0:3"]))).toEqual(
      new Map([
        ["0:0", "1:0"],
        ["0:3", "1:3"],
      ]),
    );
  });

  it("gives up on a line that only has look-alikes once another one appears", () => {
    const brace = file([50, [add("}", 50)]]);
    const grown = file([50, [add("function f() {", 50), add("}", 51), add("", 52), add("}", 53)]]);
    expect(carryKeys(rows(brace), rows(grown), new Set(["0:0"]))).toBeNull();
  });

  it("gives up once a selected line is gone", () => {
    const edited = file([10, [ctx("}", 10), del("a = 1", 11), add("a = 3", 11), ctx("}", 12)]]);
    expect(carryKeys(rows(before), rows(edited), new Set(["0:1", "0:2"]))).toBeNull();
  });
});

describe("isPicked", () => {
  const base = { key: "r", hunk: 0 };
  const split = { ...base, t: "split", kind: "chg", a: { no: 1, text: "a", sel: "0:0" }, b: { no: 1, text: "b", sel: "0:1" } } as const;

  it("counts only the clicked side of a split row", () => {
    expect(isPicked(split, "a", new Set(["0:0"]), "a")).toBe(true);
    expect(isPicked(split, "b", new Set(["0:0"]), "a")).toBe(false);
    expect(isPicked(split, null, new Set(["0:0"]), "a")).toBe(false);
    expect(isPicked({ ...base, t: "split", kind: "chg", a: { no: 1, text: "a", sel: "0:0" } }, "b", new Set(["0:0"]), "a")).toBe(false);
  });

  it("ignores a side whose column isn't the selected one, as a context line shares its key", () => {
    const ctx = { ...base, t: "split", kind: "ctx", a: { no: 1, text: "a", sel: "0:0" }, b: { no: 1, text: "a", sel: "0:0" } } as const;
    expect(isPicked(ctx, "b", new Set(["0:0"]), "a")).toBe(false);
    expect(isPicked(ctx, "a", new Set(["0:0"]), "a")).toBe(true);
  });

  it("reads a unified row's one line", () => {
    expect(isPicked({ ...base, t: "uni", kind: "del", line: { no: 1, text: "a", sel: "0:0" } }, null, new Set(["0:0"]), "u")).toBe(true);
  });
});

describe("hunkOfKey", () => {
  it("reads the hunk from a line key and none from expanded context", () => {
    expect(hunkOfKey(lineKey(3, 7))).toBe(3);
    expect(hunkOfKey(gapKey(12))).toBeNull();
  });
});
