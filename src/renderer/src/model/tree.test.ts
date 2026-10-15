import { describe, expect, it } from "vitest";
import type { FileDiff } from "../../../shared/types";
import { buildTree, type Dir } from "./tree";

const changed = (path: string, status: FileDiff["status"] = "modified"): FileDiff => ({ path, status, binary: false, additions: 1, deletions: 0, hunks: [] });

function show(dir: Dir): string[] {
  return [
    ...dir.dirs.flatMap((d) => [`${d.ignored ? "!" : ""}${d.name}/ (${d.changes})`, ...show(d).map((l) => `  ${l}`)]),
    ...dir.files.map((f) => `${f.ignored ? "!" : ""}${f.path}${f.diff ? ` ${f.diff.status}` : ""}`),
  ];
}

describe("buildTree", () => {
  const listing = { files: ["b.ts", "src/z.ts", "src/a.ts", "src/lib/x.ts"], ignored: ["IDEAS.md", "out/"] };

  it("puts folders before files, counts changes per folder and keeps deleted files", () => {
    const tree = buildTree(listing, [changed("src/a.ts"), changed("src/lib/gone.ts", "deleted")], new Map());
    expect(show(tree)).toEqual([
      "!out/ (0)",
      "src/ (2)",
      "  lib/ (1)",
      "    src/lib/gone.ts deleted",
      "    src/lib/x.ts",
      "  src/a.ts modified",
      "  src/z.ts",
      "b.ts",
      "!IDEAS.md",
    ]);
  });

  it("adds the entries of opened ignored folders", () => {
    const opened = new Map<string, string[] | string>([
      ["out/", ["out/deep/", "out/x.js"]],
      ["out/deep/", "Can't read this folder."],
    ]);
    const tree = buildTree(listing, [], opened);
    expect(show(tree).slice(0, 3)).toEqual(["!out/ (0)", "  !deep/ (0)", "  !out/x.js"]);
  });
});
