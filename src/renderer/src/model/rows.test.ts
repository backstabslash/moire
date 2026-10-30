import { describe, expect, it } from "vitest";
import { diffHunk } from "../../../main/test-repo";
import type { FileDiff, Hunk } from "../../../shared/types";
import { align, buildRows, followHunk, hunkSpans, notUtf8, type Row, type Stub, withStubs } from "./rows";

const opts = { layout: "split" as const, scope: "changed" as const, expanded: new Set<string>() };

function file(hunks: Hunk[], extra: Partial<FileDiff> = {}): FileDiff {
  return { path: "src/a.ts", status: "modified", binary: false, additions: 0, deletions: 0, hunks, ...extra };
}

const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
const hunk = diffHunk(2, [" line 2", " line 3", " line 4", "-line 5", "+line five", " line 6", " line 7", " line 8"]);
const newText = lines.map((l, i) => (i === 4 ? "line five" : l)).join("\n") + "\n";
const oldText = lines.join("\n") + "\n";

const kinds = (rows: Row[]) => rows.map((r) => (r.t === "fold" ? `fold${r.count}` : r.t));

type FoldRow = Extract<Row, { t: "fold" }>;
type HunkRow = Extract<Row, { t: "hunk" }>;
const isFold = (r: Row): r is FoldRow => r.t === "fold";
const isHunk = (r: Row): r is HunkRow => r.t === "hunk";

describe("buildRows", () => {
  it("folds the gaps before and after a hunk, but shows a single unchanged line", () => {
    const rows = buildRows(file([hunk]), { a: oldText, b: newText, hidden: false }, opts);
    expect(kinds(rows).slice(0, 2)).toEqual(["split", "hunk"]);
    expect(rows[0]).toMatchObject({ a: { no: 1, text: "line 1", sel: "g1" } });
    expect(kinds(rows).at(-1)).toBe("fold2");
    expect(rows.filter((r) => r.t === "split")).toHaveLength(8);
  });

  it("shows every line in full-file scope with correct numbers", () => {
    const rows = buildRows(file([hunk]), { a: oldText, b: newText, hidden: false }, { ...opts, scope: "full" });
    const split = rows.filter((r): r is Extract<Row, { t: "split" }> => r.t === "split");
    expect(split).toHaveLength(10);
    expect(split[9].a).toEqual({ no: 10, text: "line 10", sel: "g10" });
    expect(split[9].b).toEqual({ no: 10, text: "line 10", sel: "g10" });
  });

  it("expands one fold on request", () => {
    const contents = { a: oldText, b: newText, hidden: false };
    const { key } = buildRows(file([hunk]), contents, opts).filter(isFold)[0];
    const rows = buildRows(file([hunk]), contents, { ...opts, expanded: new Set([key]) });
    expect(kinds(rows).filter((k) => k.startsWith("fold"))).toHaveLength(0);
    expect(rows.filter((r) => r.t === "split")).toHaveLength(10);
  });

  it("draws the blinking hunk as aligned pairs in unified layout", () => {
    const rows = buildRows(file([hunk]), { a: oldText, b: newText, hidden: false }, { ...opts, layout: "unified", plates: 0 });
    const pair = rows.find((r) => r.t === "split" && r.kind === "chg");
    expect(rows.some((r) => r.t === "uni" && r.hunk === 0)).toBe(false);
    expect(pair).toMatchObject({ a: { no: 5, text: "line 5" }, b: { no: 5, text: "line five" } });
  });

  describe("revealing a long fold in steps", () => {
    const long = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
    const text = long.join("\n") + "\n";
    const at = (n: number) => diffHunk(n, [`-line ${n}`, `+new ${n}`]);
    const contents = { a: text, b: text, hidden: false };
    const folds = (expanded: string[] = [], hunks = [at(10), at(70)]) =>
      buildRows(file(hunks), contents, { ...opts, expanded: new Set(expanded) }).filter(isFold);

    it("offers both ways between hunks and only the way that exists at the ends", () => {
      const [top, middle, end] = folds();
      expect(top).toMatchObject({ count: 9 });
      expect(middle).toMatchObject({ count: 59, steps: { down: expect.any(String), up: expect.any(String) } });
      expect(end).toMatchObject({ count: 30, steps: { down: expect.any(String) } });
      expect(end.steps).not.toHaveProperty("up");
    });

    it("shrinks the fold from the side that was stepped", () => {
      const { down, up } = folds()[1].steps!;
      const [, stepped] = folds([down!]);
      expect(stepped).toMatchObject({ count: 39, newFrom: 31, steps: { up } });
      expect(stepped.steps!.down).not.toBe(down);
      const [, both] = folds([down!, up!]);
      expect(both).toMatchObject({ count: 19, newFrom: 31 });
      expect(both).not.toHaveProperty("steps");
    });

    it("drops the fold once the steps cover it, and the plain click still opens it all", () => {
      const [top, middle, end] = folds();
      const { down, up } = middle.steps!;
      const next = folds([down!])[1].steps!.down!;
      expect(folds([down!, next, up!]).map((r) => r.key)).toEqual([top.key, end.key]);
      expect(folds([middle.key]).map((r) => r.key)).toEqual([top.key, end.key]);
    });

    it("shows the revealed lines in file order on either side of the fold", () => {
      const { down, up } = folds()[1].steps!;
      const rows = buildRows(file([at(10), at(70)]), contents, { ...opts, expanded: new Set([down!, up!]) });
      const numbers = rows.flatMap((r) => (r.t === "split" && r.kind === "ctx" ? [r.b?.no] : []));
      expect(numbers).toEqual([...Array.from({ length: 20 }, (_, i) => i + 11), ...Array.from({ length: 20 }, (_, i) => i + 50)]);
    });
  });

  it("keeps folds without contents but can't expand them, and skips the unknown tail", () => {
    const rows = buildRows(file([hunk]), null, opts);
    expect(rows[0]).toMatchObject({ t: "fold", count: 1, expandable: false });
    expect(rows.at(-1)?.t).toBe("split");
  });

  it("handles a pure deletion at the end of a file", () => {
    const del = diffHunk(9, ["-line 9", "-line 10"], 8);
    const rows = buildRows(file([del]), { a: oldText, b: lines.slice(0, 8).join("\n") + "\n", hidden: false }, opts);
    expect(kinds(rows)).toEqual(["fold8", "hunk", "split", "split"]);
  });

  it("marks unchanged lines staged earlier by index line, and counts them in folds", () => {
    const lines: [number, number][] = [1, 3, 9].map((n) => [n, n === 9 ? 10 : n]);
    const staged = file([hunk], { alreadyStaged: { stagedRanges: lines, deletionsAfter: [6] } });
    const contents = { a: oldText, b: newText, hidden: false };
    const no = (r: Row & { t: "split" | "uni" }) => (r.t === "split" ? r.a?.no : r.a);
    const marked = (rows: Row[]) =>
      rows.flatMap((r) =>
        (r.t === "split" || r.t === "uni") && r.kind === "ctx" ? [`${no(r)}${r.stagedEarlier ? "d" : ""}${r.deletionAbove ? "c" : ""}`] : [],
      );

    const changed = buildRows(staged, contents, opts);
    expect(marked(changed)).toEqual(["1d", "2", "3d", "4", "6", "7c", "8"]);
    expect(changed.at(-1)).toMatchObject({ t: "fold", count: 2, stagedEarlier: 2 });

    const full = buildRows(staged, contents, { ...opts, layout: "unified", scope: "full" });
    expect(marked(full)).toEqual(["1d", "2", "3d", "4", "6", "7c", "8", "9d", "10d"]);
    expect(buildRows(file([hunk]), contents, opts).at(-1)).not.toHaveProperty("stagedEarlier");
  });
});

describe("hunk headers", () => {
  const withHeader = (header: string) => ({ ...hunk, oldStart: 4, newStart: 4, header });
  const head = (rows: Row[]) => rows.find((r) => r.t === "hunk") as Row & { t: "hunk" };
  const source = "  function outer() {\n" + lines.slice(1).join("\n") + "\n";

  it("finds the whole line git quoted, on the old side", () => {
    const rows = buildRows(file([withHeader("function outer")]), { a: source, b: source, hidden: false }, opts);
    expect(head(rows).ctxLine).toEqual({ plate: 0, no: 1, text: "  function outer() {" });
  });

  it("falls back to git's text when no line matches or there are no contents", () => {
    expect(head(buildRows(file([withHeader("gone")]), { a: source, b: source, hidden: false }, opts)).ctxLine).toBeUndefined();
    expect(head(buildRows(file([withHeader("function outer")]), null, opts)).ctxLine).toBeUndefined();
  });

  it("spans each hunk's own rows, leaving out the unchanged rows between hunks", () => {
    const later = diffHunk(12, [" x"]);
    const rows = buildRows(file([hunk, later]), { a: oldText, b: newText, hidden: false }, { ...opts, layout: "unified", scope: "full" });
    const spans = hunkSpans(rows);
    expect(spans).toHaveLength(2);
    expect(rows[spans[0].head].t).toBe("hunk");
    expect(rows[spans[0].end].t).not.toBe("hunk");
    expect((rows[spans[0].end] as Row & { hunk: number }).hunk).toBe(-1);
    expect(spans[1].end).toBe(spans[1].head + 2);
  });
});

describe("withStubs", () => {
  const contents = { a: oldText, b: newText, hidden: false };

  it("puts a staged hunk's stub where the hunk was, in line order, and drops it while the hunk is still there", () => {
    const later = diffHunk(9, [" line 9"]);
    const f = file([later]);
    const rows = buildRows(f, contents, opts);
    const stubbed = withStubs(rows, f, [
      { treeLine: 5, indexLine: 5, count: 2, undoId: "u5" },
      { treeLine: 3, indexLine: 3, count: 1, undoId: "u3", undoable: true },
    ]);
    const at = stubbed.findIndex((r) => r.t === "hunk");
    expect(stubbed.slice(at - 2, at).map((r) => r.t === "stub" && [r.treeLine, r.latest])).toEqual([
      [3, true],
      [5, false],
    ]);
    expect(withStubs(rows, f, [{ treeLine: 9, indexLine: 9, count: 1, undoId: "u9" }])).toBe(rows);
  });

  it("offers undo only on the last stub whose stage is still the newest action", () => {
    const f = file([]);
    const rows = buildRows(f, contents, opts);
    const latest = (stubs: Stub[]) => withStubs(rows, f, stubs).flatMap((r) => (r.t === "stub" && r.latest ? [r.treeLine] : []));
    expect(
      latest([
        { treeLine: 3, indexLine: 3, count: 1, undoId: "u3" },
        { treeLine: 5, indexLine: 5, count: 1, undoId: "u5" },
      ]),
    ).toEqual([]);
    expect(
      latest([
        { treeLine: 3, indexLine: 3, count: 1, undoId: "u3", undoable: true },
        { treeLine: 5, indexLine: 5, count: 1, undoId: "u5", undoable: true },
      ]),
    ).toEqual([5]);
  });
});

describe("notUtf8", () => {
  it("spots bytes UTF-8 couldn't decode, in changed lines or the rest of the file", () => {
    const latin = { ...hunk, lines: hunk.lines.map((l) => (l.kind === "add" ? { ...l, text: "caf�" } : l)) };
    expect(notUtf8(file([hunk]), { a: oldText, b: newText, hidden: false })).toBe(false);
    expect(notUtf8(file([latin]), null)).toBe(true);
    expect(notUtf8(file([hunk]), { a: oldText, b: `${newText}na�ve\n`, hidden: false })).toBe(true);
    expect(notUtf8(file([], { status: "unchanged" }), { a: null, b: "�", hidden: false })).toBe(true);
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

const change = (del: string[], add: string[]) => diffHunk(1, [...del.map((t) => `-${t}`), ...add.map((t) => `+${t}`)]);

describe("what changed when there are no lines to show", () => {
  const note = (f: FileDiff) => buildRows(f, null, opts).map((r) => r.t === "note" && r.text);

  it("names a mode change, a bare rename, and empty files", () => {
    expect(note(file([], { oldMode: "100644", newMode: "100755" }))).toEqual(["Now executable (100644 → 100755), no content changes."]);
    expect(note(file([], { oldMode: "100755", newMode: "100644" }))).toEqual(["No longer executable (100755 → 100644), no content changes."]);
    expect(note(file([], { status: "renamed", oldPath: "src/b.ts" }))).toEqual(["Renamed, no content changes."]);
    expect(note(file([], { status: "renamed", oldPath: "b.sh", oldMode: "100644", newMode: "100755" }))).toEqual([
      "Renamed, now executable, no content changes.",
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
});

describe("noise folding", () => {
  const ws = diffHunk(2, ["-  a = b", "+\ta  =  b"]);
  const folded = (del: string[], add: string[], path = "a.ts") =>
    buildRows(file([change(del, add)], { path }), null, opts).some((r) => isHunk(r) && !!r.folded);

  it("folds a noise file into one note until expanded", () => {
    const noisy = file([hunk], { noise: "Lockfile", additions: 1, deletions: 1 });
    expect(buildRows(noisy, null, opts)).toEqual([{ t: "note", key: "noise", text: "Lockfile, 2 changed lines, folded away.", expand: "noise" }]);
    expect(kinds(buildRows(noisy, null, { ...opts, expanded: new Set(["noise"]) }))).toContain("hunk");
  });

  it("folds whitespace-only hunks but not real changes", () => {
    const rows = buildRows(file([ws, hunk]), null, opts);
    expect(rows.filter((r) => r.t === "hunk").map((r) => r.t === "hunk" && !!r.folded)).toEqual([true, false]);
    const { keys } = rows.filter(isHunk)[0].folded!;
    expect(buildRows(file([ws]), null, { ...opts, expanded: new Set(keys) }).some((r) => r.t === "split" && r.kind === "chg")).toBe(true);
    expect(buildRows(file([ws]), null, { ...opts, showAll: true }).some((r) => r.t === "split" && r.kind === "chg")).toBe(true);
  });

  it("doesn't fold spaces that join words, or reindents where indentation matters", () => {
    const dedent: [string[], string[]] = [
      ["if admin:", "    grant(user)"],
      ["if admin:", "grant(user)"],
    ];
    expect(folded(['msg = "a b"'], ['msg = "ab"'])).toBe(false);
    expect(folded(["f(a,b)"], ["f(a, b)"])).toBe(true);
    expect(folded(["f(a,", "  b)"], ["f(a, b)"])).toBe(true);
    expect(folded(...dedent)).toBe(true);
    expect(folded(...dedent, "a.py")).toBe(false);
    expect(folded(["x = 1  ", "y = 2"], ["x = 1", "", "y = 2"], "a.py")).toBe(true);
  });

  it("counts whitespace inside string literals", () => {
    expect(folded(['s.split(" ")'], ['s.split("")'])).toBe(false);
    expect(folded(["xs.join(', ')"], ["xs.join(',')"])).toBe(false);
    expect(folded(["const s = `", "  a", "`;"], ["const s = `", "a", "`;"])).toBe(false);
    expect(folded(['f("a b",  x)'], ['f("a b", x)'])).toBe(true);
    expect(folded(["// don't", "f(a,b)"], ["// don't", "f(a, b)"])).toBe(true);
    expect(folded(["x = 'it\\'s  ok'"], ["x = 'it\\'s ok'"])).toBe(false);
    expect(folded(['msg = "a  b"'], ['msg = "a b"'], "a.py")).toBe(false);
  });

  it("never folds whitespace in formats where it matters", () => {
    expect(folded(["line one  "], ["line one"], "README.md")).toBe(false);
    expect(folded(["- item", "  - nested"], ["- item", "- nested"], "README.md")).toBe(false);
    expect(folded(["a  b"], ["a b"], "notes.txt")).toBe(true);
    expect(folded(["X = a "], ["X = a"], "Makefile")).toBe(false);
    expect(folded(["a\tb"], ["a b"], "data.tsv")).toBe(false);
  });

  it("offers to expand every whitespace fold in a file when there are several", () => {
    const rows = buildRows(file([ws, { ...ws, oldStart: 6, newStart: 6 }]), null, opts);
    const folds = rows.flatMap((r) => (r.t === "hunk" && r.folded ? [r.folded] : []));
    expect(folds).toHaveLength(2);
    expect(folds.map((f) => f.allWhitespaceFolds)).toEqual([folds.flatMap((f) => f.keys), undefined]);
    const one = buildRows(file([ws]), null, opts).find((r) => r.t === "hunk");
    expect(one?.t === "hunk" && one.folded && !one.folded.allWhitespaceFolds).toBe(true);
  });

  it("folds a whitespace-only hunk into one row with the unchanged lines around it", () => {
    const text = { a: lines.join("\n") + "\n", b: lines.join("\n") + "\n", hidden: false };
    const real = diffHunk(6, ["-line 6", "+line six"]);
    const rows = buildRows(file([ws, real]), text, opts);
    expect(kinds(rows)).toEqual(["hunk", "hunk", "split", "fold4"]);
    expect(rows[0]).toMatchObject({
      hunk: 0,
      folded: {
        count: 4,
        gaps: [
          [1, 1],
          [3, 3],
        ],
      },
    });
    const { keys } = rows.filter(isHunk)[0].folded!;
    expect(keys).toHaveLength(3);
    const open = buildRows(file([ws, real]), text, { ...opts, expanded: new Set(keys) });
    expect(open.filter((r) => r.t === "hunk").map((r) => r.t === "hunk" && !!r.folded)).toEqual([false, false]);
  });
});

describe("unchanged files from the tree", () => {
  const unchanged = file([], { status: "unchanged" });

  it("shows every line unified, numbered on B, whatever the scope and layout", () => {
    const rows = buildRows(unchanged, { a: null, b: newText, hidden: false }, opts);
    expect(rows).toHaveLength(10);
    expect(rows[4]).toMatchObject({ t: "uni", kind: "ctx", b: 5, line: { text: "line five", sel: "g5" } });
  });

  it("explains files it can't show", () => {
    const note = (contents: { a: null; b: string | null; hidden: boolean }) => buildRows(unchanged, contents, opts).map((r) => r.t === "note" && r.text);
    expect(note({ a: null, b: null, hidden: true })).toEqual(["Binary file or over 2 MB, contents not shown."]);
    expect(note({ a: null, b: null, hidden: false })).toEqual(["Can't read this file."]);
    expect(note({ a: null, b: "", hidden: false })).toEqual(["Empty file."]);
    const flagged = (extra: Partial<FileDiff>) =>
      buildRows({ ...unchanged, ...extra }, { a: null, b: null, hidden: true }, opts).map((r) => r.t === "note" && r.text);
    expect(flagged({ binary: true })).toEqual(["Binary file, contents not shown."]);
    expect(flagged({ tooLarge: true })).toEqual(["File is over 2 MB, contents not shown."]);
  });
});
