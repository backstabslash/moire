import { describe, expect, it } from "vitest";
import type { FileDiff, Hunk } from "../../../shared/types";
import { copyCode, copyMarkdown } from "./copy";
import { fuzzyMatch } from "./files";
import { align, buildRows, followHunk, type Row } from "./rows";
import { compile, type SearchOptions, searchFile } from "./search";

const opts = { layout: "split" as const, scope: "changed" as const, expanded: new Set<string>() };

function file(hunks: Hunk[], extra: Partial<FileDiff> = {}): FileDiff {
  return { path: "src/a.ts", status: "modified", binary: false, additions: 0, deletions: 0, hunks, ...extra };
}

// a 10-line file where line 5 changed
const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
const hunk: Hunk = {
  oldStart: 2,
  oldLines: 7,
  newStart: 2,
  newLines: 7,
  header: "",
  lines: [
    ...[2, 3, 4].map((n) => ({ kind: "ctx" as const, text: `line ${n}`, oldNo: n, newNo: n })),
    { kind: "del", text: "line 5", oldNo: 5 },
    { kind: "add", text: "line five", newNo: 5 },
    ...[6, 7, 8].map((n) => ({ kind: "ctx" as const, text: `line ${n}`, oldNo: n, newNo: n })),
  ],
};
const newText = lines.map((l, i) => (i === 4 ? "line five" : l)).join("\n") + "\n";
const oldText = lines.join("\n") + "\n";

const kinds = (rows: Row[]) => rows.map((r) => (r.t === "fold" ? `fold${r.count}` : r.t));

describe("buildRows", () => {
  it("folds the gaps before and after a hunk", () => {
    const rows = buildRows(file([hunk]), { a: oldText, b: newText, tooLarge: false }, opts);
    expect(kinds(rows)[0]).toBe("fold1");
    expect(kinds(rows).at(-1)).toBe("fold2");
    expect(rows.filter((r) => r.t === "split")).toHaveLength(7);
  });

  it("shows every line in full-file scope with correct numbers", () => {
    const rows = buildRows(file([hunk]), { a: oldText, b: newText, tooLarge: false }, { ...opts, scope: "full" });
    const split = rows.filter((r): r is Extract<Row, { t: "split" }> => r.t === "split");
    expect(split).toHaveLength(10);
    expect(split[9].a).toEqual({ no: 10, text: "line 10", sel: "g10" });
    expect(split[9].b).toEqual({ no: 10, text: "line 10", sel: "g10" });
  });

  it("expands one fold on request", () => {
    const rows = buildRows(file([hunk]), { a: oldText, b: newText, tooLarge: false }, { ...opts, expanded: new Set(["gap1"]) });
    expect(kinds(rows)[0]).toBe("fold1");
    expect(kinds(rows).filter((k) => k.startsWith("fold"))).toHaveLength(1);
  });

  it("draws the blinking hunk as aligned pairs in unified layout", () => {
    const rows = buildRows(file([hunk]), { a: oldText, b: newText, tooLarge: false }, { ...opts, layout: "unified", plates: 0 });
    const pair = rows.find((r) => r.t === "split" && r.kind === "chg");
    expect(rows.some((r) => r.t === "uni")).toBe(false);
    expect(pair).toMatchObject({ a: { no: 5, text: "line 5" }, b: { no: 5, text: "line five" } });
  });

  it("keeps folds without contents but can't expand them, and skips the unknown tail", () => {
    const rows = buildRows(file([hunk]), null, opts);
    expect(rows[0]).toMatchObject({ t: "fold", count: 1, expandable: false });
    expect(rows.at(-1)?.t).toBe("split");
  });

  it("handles a pure deletion at the end of a file", () => {
    const del: Hunk = { oldStart: 9, oldLines: 2, newStart: 8, newLines: 0, header: "", lines: [{ kind: "del", text: "line 9", oldNo: 9 }, { kind: "del", text: "line 10", oldNo: 10 }] };
    const rows = buildRows(file([del]), { a: oldText, b: lines.slice(0, 8).join("\n") + "\n", tooLarge: false }, opts);
    expect(kinds(rows)).toEqual(["fold8", "hunk", "split", "split"]);
  });

  it("explains binary and oversized files instead of drawing rows", () => {
    expect(buildRows(file([], { binary: true }), null, opts)[0]).toMatchObject({ t: "note" });
    expect(buildRows(file([], { tooLarge: true }), null, opts)[0]).toMatchObject({ t: "note" });
  });
});

describe("followHunk", () => {
  const at = (oldStart: number, text: string): Hunk => ({ ...hunk, oldStart, lines: [{ kind: "add", text, newNo: oldStart }] });

  it("finds the same hunk after one appears above it", () => {
    expect(followHunk(at(30, "x"), [at(2, "new"), at(10, "a"), at(30, "x")])).toBe(2);
  });

  it("falls back to the nearest position when the hunk itself changed", () => {
    expect(followHunk(at(30, "x"), [at(2, "new"), at(29, "x edited"), at(60, "y")])).toBe(1);
  });
});

describe("align", () => {
  const side = (no: number, text: string) => ({ no, text });

  it("pairs a changed line with its edit, not with a comment inserted above it", () => {
    const pairs = align([side(27, "max: get('MAX').default('600000'),")], [side(27, "// explain the new limit"), side(28, "max: get('MAX').default('86400000'),")]);
    expect(pairs.map(([a, b]) => [a?.no, b?.no])).toEqual([
      [undefined, 27],
      [27, 28],
    ]);
    expect(pairs[1][1]?.words?.length).toBeGreaterThan(0);
  });

  it("pairs unrelated lines by position, like a rewrite", () => {
    const pairs = align([side(1, "alpha beta"), side(2, "gamma")], [side(1, "totally different"), side(2, "x")]);
    expect(pairs.map(([a, b]) => [a?.no, b?.no])).toEqual([
      [1, 1],
      [2, 2],
    ]);
  });
});

describe("copying selected lines", () => {
  const contents = { a: oldText, b: newText, tooLarge: false };
  const sides = { a: { kind: "index" as const, label: "Index" }, b: { kind: "worktree" as const, label: "Working tree" } };

  it("copies code in file order, deletion before its replacement", () => {
    const sel = new Set(["0:3", "0:4", "0:5"]);
    expect(copyCode(file([hunk]), contents, new Set(), sel)).toEqual({ text: "line 5\nline five\nline 6\n", count: 3 });
  });

  it("copies one Markdown block per run of adjacent lines", () => {
    const sel = new Set(["g1", "0:4", "0:6", "0:7"]);
    expect(copyMarkdown(file([hunk]), contents, new Set(), sel, sides).text).toBe(
      "src/a.ts line 1 (working tree)\n```typescript\nline 1\n```\n\n" +
        "src/a.ts line 5 (working tree)\n```diff\n+line five\n```\n\n" +
        "src/a.ts lines 7–8 (working tree)\n```typescript\nline 7\nline 8\n```\n",
    );
  });

  it("numbers a run of deleted lines on the old side", () => {
    expect(copyMarkdown(file([hunk]), contents, new Set(), new Set(["0:3"]), sides).text).toBe("src/a.ts line 5 (index)\n```diff\n-line 5\n```\n");
  });
});

describe("search", () => {
  const contents = { a: oldText, b: newText, tooLarge: false };
  const find = (query: string, extra: Partial<SearchOptions> = {}) => {
    const re = compile({ query, matchCase: false, regex: false, side: "both", ...extra });
    return re instanceof RegExp ? searchFile(file([hunk]), contents, re, extra.side ?? "both", 100).map((h) => `${h.sel}@${h.start}`) : re;
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

describe("noise folding", () => {
  const ws: Hunk = {
    oldStart: 2,
    oldLines: 1,
    newStart: 2,
    newLines: 1,
    header: "",
    lines: [
      { kind: "del", text: "  a = b", oldNo: 2 },
      { kind: "add", text: "\ta  =  b", newNo: 2 },
    ],
  };

  it("folds a noise file into one note until expanded", () => {
    const noisy = file([hunk], { noise: "Lockfile", additions: 1, deletions: 1 });
    expect(buildRows(noisy, null, opts)).toEqual([{ t: "note", key: "noise", text: "Lockfile, 2 changed lines, folded away.", expand: "noise" }]);
    expect(kinds(buildRows(noisy, null, { ...opts, expanded: new Set(["noise"]) }))).toContain("hunk");
  });

  it("folds whitespace-only hunks but not real changes", () => {
    const rows = buildRows(file([ws, hunk]), null, opts);
    expect(rows.filter((r) => r.t === "fold" && r.label)).toEqual([expect.objectContaining({ key: "ws0", hunk: 0, label: "Whitespace-only changes" })]);
    expect(buildRows(file([ws]), null, { ...opts, expanded: new Set(["ws0"]) }).some((r) => r.t === "split" && r.kind === "chg")).toBe(true);
    expect(buildRows(file([ws]), null, { ...opts, showAll: true }).some((r) => r.t === "split" && r.kind === "chg")).toBe(true);
  });

  it("fuzzy-matches paths", () => {
    expect(fuzzyMatch("stts", "src/main/stage.test.ts")).toBe(true);
    expect(fuzzyMatch("main stage", "src/main/stage.ts")).toBe(true);
    expect(fuzzyMatch("zz", "src/main/stage.ts")).toBe(false);
  });
});
