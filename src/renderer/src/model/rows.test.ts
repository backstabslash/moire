import { describe, expect, it } from "vitest";
import type { FileDiff, Hunk } from "../../../shared/types";
import { copyCode, copyMarkdown } from "./copy";
import { fuzzyMatch } from "./files";
import { modeNote } from "./modes";
import { align, buildRows, followHunk, notUtf8, type Row } from "./rows";
import { compile, type SearchOptions, searchFile } from "./search";

const opts = { layout: "split" as const, scope: "changed" as const, expanded: new Set<string>() };

function file(hunks: Hunk[], extra: Partial<FileDiff> = {}): FileDiff {
  return { path: "src/a.ts", status: "modified", binary: false, additions: 0, deletions: 0, hunks, ...extra };
}

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
  it("folds the gaps before and after a hunk, but shows a single unchanged line", () => {
    const rows = buildRows(file([hunk]), { a: oldText, b: newText, tooLarge: false }, opts);
    expect(kinds(rows).slice(0, 2)).toEqual(["split", "hunk"]);
    expect(rows[0]).toMatchObject({ a: { no: 1, text: "line 1", sel: "g1" } });
    expect(kinds(rows).at(-1)).toBe("fold2");
    expect(rows.filter((r) => r.t === "split")).toHaveLength(8);
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
    expect(kinds(rows).filter((k) => k.startsWith("fold"))).toHaveLength(0);
    expect(rows.filter((r) => r.t === "split")).toHaveLength(10);
  });

  it("draws the blinking hunk as aligned pairs in unified layout", () => {
    const rows = buildRows(file([hunk]), { a: oldText, b: newText, tooLarge: false }, { ...opts, layout: "unified", plates: 0 });
    const pair = rows.find((r) => r.t === "split" && r.kind === "chg");
    expect(rows.some((r) => r.t === "uni" && r.hunk === 0)).toBe(false);
    expect(pair).toMatchObject({ a: { no: 5, text: "line 5" }, b: { no: 5, text: "line five" } });
  });

  it("keeps folds without contents but can't expand them, and skips the unknown tail", () => {
    const rows = buildRows(file([hunk]), null, opts);
    expect(rows[0]).toMatchObject({ t: "fold", count: 1, expandable: false });
    expect(rows.at(-1)?.t).toBe("split");
  });

  it("handles a pure deletion at the end of a file", () => {
    const del: Hunk = {
      oldStart: 9,
      oldLines: 2,
      newStart: 8,
      newLines: 0,
      header: "",
      lines: [
        { kind: "del", text: "line 9", oldNo: 9 },
        { kind: "del", text: "line 10", oldNo: 10 },
      ],
    };
    const rows = buildRows(file([del]), { a: oldText, b: lines.slice(0, 8).join("\n") + "\n", tooLarge: false }, opts);
    expect(kinds(rows)).toEqual(["fold8", "hunk", "split", "split"]);
  });

  it("explains binary and oversized files instead of drawing rows", () => {
    expect(buildRows(file([], { binary: true }), null, opts)[0]).toMatchObject({ t: "note" });
    expect(buildRows(file([], { tooLarge: true }), null, opts)[0]).toMatchObject({ t: "note" });
  });
});

describe("notUtf8", () => {
  it("spots bytes UTF-8 couldn't decode, in changed lines or the rest of the file", () => {
    const latin = { ...hunk, lines: hunk.lines.map((l) => (l.kind === "add" ? { ...l, text: "caf�" } : l)) };
    expect(notUtf8(file([hunk]), { a: oldText, b: newText, tooLarge: false })).toBe(false);
    expect(notUtf8(file([latin]), null)).toBe(true);
    expect(notUtf8(file([hunk]), { a: oldText, b: `${newText}na�ve\n`, tooLarge: false })).toBe(true);
    expect(notUtf8(file([], { status: "unchanged" }), { a: null, b: "�", tooLarge: false })).toBe(true);
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
    const pairs = align(
      [side(27, "max: get('MAX').default('600000'),")],
      [side(27, "// explain the new limit"), side(28, "max: get('MAX').default('86400000'),")],
    );
    expect(pairs.map(([a, b]) => [a?.no, b?.no])).toEqual([
      [undefined, 27],
      [27, 28],
    ]);
    expect(pairs[1][1]?.words?.length).toBeGreaterThan(0);
  });

  it("marks the edited words of a long prose line", () => {
    const prose = "The draft validates and renders every payload from one plan file, with a summary and a Slack text. ".repeat(7);
    const [[a, b]] = align([side(19, `${prose}Run draft/shield-build/tests/test_plan.py.`)], [side(19, `${prose}Run draft/tests/test_plan.py.`)]);
    expect(a?.words).toEqual([[prose.length + 10, prose.length + 23]]);
    expect(b?.words).toEqual([]);
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
        "src/a.ts line 5 (added, working tree)\n```typescript\nline five\n```\n\n" +
        "src/a.ts lines 7–8 (working tree)\n```typescript\nline 7\nline 8\n```\n",
    );
  });

  it("keeps a diff block only when the signs say something", () => {
    const mixed = copyMarkdown(file([hunk]), contents, new Set(), new Set(["0:4", "0:5"]), sides).text;
    expect(mixed).toBe("src/a.ts lines 5–6 (working tree)\n```diff\n+line five\n line 6\n```\n");
    const fresh = { ...file([hunk]), status: "untracked" as const };
    expect(copyMarkdown(fresh, contents, new Set(), new Set(["0:4"]), sides).text).toBe(
      "src/a.ts line 5 (new file, working tree)\n```typescript\nline five\n```\n",
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

const change = (del: string[], add: string[]): Hunk => ({
  oldStart: 1,
  oldLines: del.length,
  newStart: 1,
  newLines: add.length,
  header: "",
  lines: [...del.map((text, i) => ({ kind: "del" as const, text, oldNo: i + 1 })), ...add.map((text, i) => ({ kind: "add" as const, text, newNo: i + 1 }))],
});

describe("what changed when there are no lines to show", () => {
  const note = (f: FileDiff) => buildRows(f, null, opts).map((r) => r.t === "note" && r.text);

  it("names a mode change, a bare rename, and empty files", () => {
    expect(note(file([], { oldMode: "100644", newMode: "100755" }))).toEqual(["Now executable (100644 → 100755), no content changes."]);
    expect(note(file([], { oldMode: "100755", newMode: "100644" }))).toEqual(["No longer executable (100755 → 100644), no content changes."]);
    expect(note(file([], { status: "renamed", oldPath: "src/b.ts" }))).toEqual(["Renamed from src/b.ts, no content changes."]);
    expect(note(file([], { status: "renamed", oldPath: "b.sh", oldMode: "100644", newMode: "100755" }))).toEqual([
      "Renamed from b.sh, now executable, no content changes.",
    ]);
    expect(note(file([], { status: "untracked" }))).toEqual(["Empty file."]);
    expect(note(file([], { status: "deleted" }))).toEqual(["Deleted an empty file."]);
    expect(note(file([]))).toEqual(["No content changes."]);
  });

  it("says a renamed binary was renamed, and that a tracked file's changes are too large", () => {
    expect(note(file([], { status: "renamed", oldPath: "a.png", binary: true }))).toEqual(["Renamed from a.png. Binary file, contents not shown."]);
    expect(note(file([], { tooLarge: true }))).toEqual(["Over 2 MB of changes, not shown."]);
    expect(note(file([], { status: "untracked", tooLarge: true }))).toEqual(["File is over 2 MB, contents not shown."]);
  });

  it("shows where a symlink points rather than its target as text", () => {
    const link = { oldMode: "120000", newMode: "120000" };
    expect(note(file([change(["a.txt"], ["b.txt"])], link))).toEqual(["Symlink target changed from a.txt to b.txt."]);
    expect(note(file([change([], ["b.txt"])], { status: "untracked", newMode: "120000" }))).toEqual(["Symlink to b.txt."]);
    expect(note(file([change(["a.txt"], [])], { status: "deleted", oldMode: "120000" }))).toEqual(["Deleted a symlink to a.txt."]);
    expect(buildRows(file([change(["x"], ["a.txt"])], { oldMode: "100644", newMode: "120000" }), null, opts).some((r) => r.t === "split")).toBe(true);
  });

  it("says where a submodule moved", () => {
    const sub = (del: string[], add: string[], extra: Partial<FileDiff> = { oldMode: "160000", newMode: "160000" }) =>
      note(
        file(
          [
            change(
              del.map((s) => `Subproject commit ${s}`),
              add.map((s) => `Subproject commit ${s}`),
            ),
          ],
          extra,
        ),
      );
    const [x, y] = ["3cfd90836a3deeda6d5f653afcba69cab9787736", "b86909db604d6e4824c2ce2b48d7cdc457ac98a9"];
    expect(sub([x], [y])).toEqual(["Submodule moved from 3cfd908 to b86909d."]);
    expect(sub([x], [`${y}-dirty`])).toEqual(["Submodule moved from 3cfd908 to b86909d, with uncommitted changes inside it."]);
    expect(sub([x], [`${x}-dirty`])).toEqual(["Submodule has uncommitted changes inside it."]);
    expect(sub([], [y], { status: "added", newMode: "160000" })).toEqual(["Submodule added at b86909d."]);
  });

  it("describes mode changes in plain words, with a short tag", () => {
    expect(modeNote({ oldMode: "100644", newMode: "100755" })).toEqual({ words: "now executable", tag: "+x" });
    expect(modeNote({ oldMode: "100644", newMode: "120000" })).toEqual({ words: "file type changed to symlink", tag: "link" });
    expect(modeNote({ oldMode: "120000", newMode: "100755" })).toEqual({ words: "file type changed to file", tag: "file" });
    expect(modeNote({ oldMode: "120000", newMode: "120000" })).toEqual({ words: "symlink", tag: "link" });
    expect(modeNote({ newMode: "100755" })).toEqual({ words: "executable", tag: "+x" });
    expect(modeNote({ oldMode: "100755" })).toBeNull();
    expect(modeNote({})).toBeNull();
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
    expect(rows.filter((r) => r.t === "hunk").map((r) => r.t === "hunk" && !!r.folded)).toEqual([true, false]);
    expect(buildRows(file([ws]), null, { ...opts, expanded: new Set(["ws0"]) }).some((r) => r.t === "split" && r.kind === "chg")).toBe(true);
    expect(buildRows(file([ws]), null, { ...opts, showAll: true }).some((r) => r.t === "split" && r.kind === "chg")).toBe(true);
  });

  it("doesn't fold spaces that join words, or reindents where indentation matters", () => {
    const folded = (path: string, h: Hunk) => buildRows(file([h], { path }), null, opts).some((r) => r.t === "hunk" && !!r.folded);
    const dedent = change(["if admin:", "    grant(user)"], ["if admin:", "grant(user)"]);
    expect(folded("a.ts", change(['msg = "a b"'], ['msg = "ab"']))).toBe(false);
    expect(folded("a.ts", change(["f(a,b)"], ["f(a, b)"]))).toBe(true);
    expect(folded("a.ts", change(["f(a,", "  b)"], ["f(a, b)"]))).toBe(true);
    expect(folded("a.ts", dedent)).toBe(true);
    expect(folded("a.py", dedent)).toBe(false);
    expect(folded("a.py", change(["x = 1  ", "y = 2"], ["x = 1", "", "y = 2"]))).toBe(true);
  });

  it("counts whitespace inside string literals", () => {
    const folded = (del: string[], add: string[], path = "a.ts") =>
      buildRows(file([change(del, add)], { path }), null, opts).some((r) => r.t === "hunk" && !!r.folded);
    expect(folded(['s.split(" ")'], ['s.split("")'])).toBe(false);
    expect(folded(["xs.join(', ')"], ["xs.join(',')"])).toBe(false);
    expect(folded(["const s = `", "  a", "`;"], ["const s = `", "a", "`;"])).toBe(false);
    expect(folded(['f("a b",  x)'], ['f("a b", x)'])).toBe(true);
    expect(folded(["// don't", "f(a,b)"], ["// don't", "f(a, b)"])).toBe(true);
    expect(folded(["x = 'it\\'s  ok'"], ["x = 'it\\'s ok'"])).toBe(false);
    expect(folded(['msg = "a  b"'], ['msg = "a b"'], "a.py")).toBe(false);
  });

  it("never folds whitespace in formats where it matters", () => {
    const folded = (path: string, del: string[], add: string[]) =>
      buildRows(file([change(del, add)], { path }), null, opts).some((r) => r.t === "hunk" && !!r.folded);
    expect(folded("README.md", ["line one  "], ["line one"])).toBe(false);
    expect(folded("README.md", ["- item", "  - nested"], ["- item", "- nested"])).toBe(false);
    expect(folded("notes.txt", ["a  b"], ["a b"])).toBe(true);
    expect(folded("Makefile", ["X = a "], ["X = a"])).toBe(false);
    expect(folded("data.tsv", ["a\tb"], ["a b"])).toBe(false);
  });

  it("offers to expand every whitespace fold in a file when there are several", () => {
    const rows = buildRows(file([ws, { ...ws, oldStart: 6, newStart: 6 }]), null, opts);
    const folds = rows.flatMap((r) => (r.t === "hunk" && r.folded ? [r.folded] : []));
    expect(folds).toHaveLength(2);
    expect(folds.map((f) => f.all)).toEqual([["ws0", "ws1"], undefined]);
    const one = buildRows(file([ws]), null, opts).find((r) => r.t === "hunk");
    expect(one?.t === "hunk" && one.folded && !one.folded.all).toBe(true);
  });

  it("folds minified files like generated ones", () => {
    const min = file([hunk], { noise: "Minified file", additions: 1, deletions: 1 });
    expect(buildRows(min, null, opts)[0]).toMatchObject({ text: "Minified file, 2 changed lines, folded away.", expand: "noise" });
  });

  it("folds a whitespace-only hunk into one row with the unchanged lines around it", () => {
    const text = { a: lines.join("\n") + "\n", b: lines.join("\n") + "\n", tooLarge: false };
    const real: Hunk = {
      oldStart: 6,
      oldLines: 1,
      newStart: 6,
      newLines: 1,
      header: "",
      lines: [
        { kind: "del", text: "line 6", oldNo: 6 },
        { kind: "add", text: "line six", newNo: 6 },
      ],
    };
    const rows = buildRows(file([ws, real]), text, opts);
    expect(kinds(rows)).toEqual(["hunk", "hunk", "split", "fold4"]);
    expect(rows[0]).toMatchObject({
      hunk: 0,
      folded: {
        keys: ["gap0", "ws0", "gap1"],
        count: 4,
        gaps: [
          [1, 1],
          [3, 3],
        ],
      },
    });
    const open = buildRows(file([ws, real]), text, { ...opts, expanded: new Set(["gap0", "ws0", "gap1"]) });
    expect(open.filter((r) => r.t === "hunk").map((r) => r.t === "hunk" && !!r.folded)).toEqual([false, false]);
  });

  it("fuzzy-matches paths", () => {
    expect(fuzzyMatch("stts", "src/main/stage.test.ts")).toBe(true);
    expect(fuzzyMatch("main stage", "src/main/stage.ts")).toBe(true);
    expect(fuzzyMatch("zz", "src/main/stage.ts")).toBe(false);
  });
});

describe("unchanged files from the tree", () => {
  const unchanged = file([], { status: "unchanged" });
  const sides = { a: { kind: "index" as const, label: "Index" }, b: { kind: "worktree" as const, label: "Working tree" } };

  it("shows every line unified, numbered on B, whatever the scope and layout", () => {
    const rows = buildRows(unchanged, { a: null, b: newText, tooLarge: false }, opts);
    expect(rows).toHaveLength(10);
    expect(rows[4]).toMatchObject({ t: "uni", kind: "ctx", b: 5, line: { text: "line five", sel: "g5" } });
  });

  it("explains files it can't show", () => {
    const note = (contents: { a: null; b: string | null; tooLarge: boolean }) => buildRows(unchanged, contents, opts).map((r) => r.t === "note" && r.text);
    expect(note({ a: null, b: null, tooLarge: true })).toEqual(["Binary file or over 2 MB, contents not shown."]);
    expect(note({ a: null, b: null, tooLarge: false })).toEqual(["Can't read this file."]);
    expect(note({ a: null, b: "", tooLarge: false })).toEqual(["Empty file."]);
  });

  it("copies selected lines as plain code from the working tree", () => {
    const text = copyMarkdown(unchanged, { a: null, b: newText, tooLarge: false }, new Set(), new Set(["g4", "g5"]), sides).text;
    expect(text).toBe("src/a.ts lines 4–5 (working tree)\n```typescript\nline 4\nline five\n```\n");
  });
});
