import { describe, expect, it } from "vitest";
import { diffHunk } from "../../../main/test-repo";
import type { FileDiff } from "../../../shared/types";
import { compile, type SearchOptions, searchFile } from "./search";

const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
const file: FileDiff = {
  path: "src/a.ts",
  status: "modified",
  binary: false,
  additions: 1,
  deletions: 1,
  hunks: [diffHunk(2, [" line 2", " line 3", " line 4", "-line 5", "+line five", " line 6", " line 7", " line 8"])],
};
const contents = { a: lines.join("\n") + "\n", b: lines.with(4, "line five").join("\n") + "\n", hidden: false };

describe("search", () => {
  const find = (query: string, extra: Partial<SearchOptions> = {}) => {
    const re = compile({ query, matchCase: false, regex: false, side: "both", ...extra });
    return re instanceof RegExp ? searchFile(file, contents, re, extra.side ?? "both", 100).map((h) => `${h.sel}@${h.start}`) : re;
  };

  it("finds hits in folded context and in changes, in file order", () => {
    expect(find("line 1")).toEqual(["g1@0", "g10@0"]);
    expect(find("FIVE")).toEqual(["0:4@5"]);
    expect(find("line 5")).toEqual(["0:3@0"]);
  });

  it("limits hits to one side, and honours case and regex", () => {
    expect(find("line 5", { side: "b" })).toEqual([]);
    expect(find("five", { side: "a" })).toEqual([]);
    expect(find("FIVE", { matchCase: true })).toEqual([]);
    expect(find("line [89]", { regex: true })).toEqual(["0:7@0", "g9@0"]);
    expect(find("line [89]")).toEqual([]);
    expect(find("(", { regex: true })).toBe("invalid");
    expect(find("")).toBeNull();
  });
});
