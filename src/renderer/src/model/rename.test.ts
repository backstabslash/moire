import { describe, expect, it } from "vitest";
import { renameParts } from "./rename";

describe("renameParts", () => {
  it("drops shared folders and marks whole words that changed", () => {
    expect(renameParts("src/ui/FileTree.tsx", "src/ui/FileTable.tsx")).toEqual([
      ["File", "Tree", ".tsx"],
      ["File", "Table", ".tsx"],
    ]);
    expect(renameParts("old.ts", "older.ts")).toEqual([
      ["", "old", ".ts"],
      ["", "older", ".ts"],
    ]);
    expect(renameParts("src/useDiff.ts", "src/useDiffs.ts")).toEqual([
      ["use", "Diff", ".ts"],
      ["use", "Diffs", ".ts"],
    ]);
  });

  it("keeps the folders when the file moved", () => {
    expect(renameParts("src/a/x.ts", "src/b/x.ts")).toEqual([
      ["", "a", "/x.ts"],
      ["", "b", "/x.ts"],
    ]);
    expect(renameParts("src/parts/x.ts", "src/x.ts")).toEqual([
      ["", "parts/", "x.ts"],
      ["", "", "x.ts"],
    ]);
  });

  it("marks everything when nothing lines up", () => {
    expect(renameParts("a.md", "b.txt")).toEqual([
      ["", "a.md", ""],
      ["", "b.txt", ""],
    ]);
  });
});
