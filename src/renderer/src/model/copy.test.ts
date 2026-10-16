import { describe, expect, it } from "vitest";
import type { DiffLine, FileDiff, Hunk } from "../../../shared/types";
import { copySide, textBetween } from "./copy";
import { buildRows, type Row } from "./rows";

const old = Array.from({ length: 20 }, (_, i) => `const v${i + 1} = ${i + 1};`);
const changed = old.map((l, i) => (i === 4 || i === 15 ? l.replace("=", "= 10 *") : l));
const oldText = old.join("\n") + "\n";
const newText = changed.join("\n") + "\n";

function hunk(at: number): Hunk {
  const ctx = (n: number): DiffLine => ({ kind: "ctx", text: old[n - 1], oldNo: n, newNo: n });
  return {
    oldStart: at - 3,
    oldLines: 7,
    newStart: at - 3,
    newLines: 7,
    header: "",
    lines: [
      ctx(at - 3),
      ctx(at - 2),
      ctx(at - 1),
      { kind: "del", text: old[at - 1], oldNo: at },
      { kind: "add", text: changed[at - 1], newNo: at },
      ctx(at + 1),
      ctx(at + 2),
      ctx(at + 3),
    ],
  };
}

const file: FileDiff = { path: "a.ts", status: "modified", binary: false, additions: 2, deletions: 2, hunks: [hunk(5), hunk(16)] };
const contents = { a: oldText, b: newText, tooLarge: false };
const rows = (layout: "split" | "unified") => buildRows(file, contents, { layout, scope: "changed", expanded: new Set() });
const at = (list: Row[], side: "a" | "b" | "line", no: number) =>
  list.findIndex((r) => (r.t === "split" ? r[side === "line" ? "b" : side]?.no === no : r.t === "uni" && side === "line" && r.line.no === no));

describe("textBetween", () => {
  it("copies one side between two rows, with partial first and last lines, skipping headers and folds", () => {
    const split = rows("split");
    const from = { index: at(split, "b", 4), offset: 6 };
    const to = { index: at(split, "b", 14), offset: 9 };
    expect(textBetween(split, "b", from, to)).toBe(
      ["v4 = 4;", changed[4], "const v6 = 6;", "const v7 = 7;", "const v8 = 8;", "const v13 = 13;", "const v14"].join("\n"),
    );
    expect(textBetween(split, "a", { index: at(split, "a", 5) }, { index: at(split, "a", 6), offset: 0 })).toBe(`${old[4]}\n`);
  });

  it("copies part of a single line", () => {
    const split = rows("split");
    const i = at(split, "b", 5);
    expect(textBetween(split, "b", { index: i, offset: 6 }, { index: i, offset: 9 })).toBe("v5 ");
  });

  it("copies unified rows as shown, without signs", () => {
    const uni = rows("unified");
    expect(textBetween(uni, "u", { index: at(uni, "line", 4) }, { index: at(uni, "line", 6) })).toBe(
      ["const v4 = 4;", old[4], changed[4], "const v6 = 6;"].join("\n"),
    );
  });
});

describe("copySide", () => {
  it("copies a whole side byte for byte, trailing newline included", () => {
    expect(copySide(contents, "b")).toEqual({ text: newText, count: 20 });
    expect(copySide(contents, "a")).toEqual({ text: oldText, count: 20 });
    expect(copySide({ a: null, b: "no newline", tooLarge: false }, "b")).toEqual({ text: "no newline", count: 1 });
  });

  it("has nothing to copy for a missing side or a file too large to show", () => {
    expect(copySide({ a: null, b: "x\n", tooLarge: false }, "a")).toBeNull();
    expect(copySide({ a: null, b: null, tooLarge: true }, "b")).toBeNull();
    expect(copySide(null, "b")).toBeNull();
  });
});
