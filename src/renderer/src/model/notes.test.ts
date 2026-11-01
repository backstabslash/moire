import { describe, expect, it } from "vitest";
import type { AgentNotes, FileDiff, Hunk } from "../../../shared/types";
import { chapterFile, chapterHunks, chapterText, diffHunk } from "../../../main/test-repo";
import { spacingOf } from "./rows";
import {
  OUTER_SPACE_IS_FREE,
  captionOf,
  checksOf,
  firstStopLeft,
  holdsMultilineText,
  hunkAt,
  leadOf,
  lineKeys,
  nextStep,
  nextStop,
  noteSpans,
  rowNotes,
  rowOfLine,
  rowToShow,
  sameStop,
  shortNames,
  skimOf,
  stepNote,
  stepCount,
  stopsOf,
  whitespaceOnly,
} from "./notes";
import { buildRows, type Row } from "./rows";

describe("stopsOf", () => {
  it("lists every range of every chapter in order", () => {
    const range = { path: "a.ts" };
    const notes = {
      chapters: [
        { title: "A", text: "", ranges: [range, range] },
        { title: "B", text: "", ranges: [range] },
      ],
    };
    expect(stopsOf(notes).map(({ chapter, range }) => [chapter, range])).toEqual([
      [0, 0],
      [0, 1],
      [1, 0],
    ]);
  });

  it("starts a step at each note, and joins ranges that share a screen", () => {
    const ranges = [
      { path: "a.ts", lines: [1, 2] as [number, number], note: "First." },
      { path: "a.ts", lines: [10, 12] as [number, number] },
      { path: "a.ts", lines: [200, 201] as [number, number] },
      { path: "b.ts", lines: [1, 1] as [number, number] },
      { path: "b.ts" },
      { path: "b.ts", lines: [5, 5] as [number, number], note: "Second." },
    ];
    const stops = stopsOf({ chapters: [{ title: "A", text: "", carries: true, ranges }] });
    expect(stops.map((s) => s.step)).toEqual([0, 0, 0, 0, 0, 1]);
    expect(stops.map((s) => s.joined)).toEqual([false, true, false, false, false, false]);
    expect(leadOf(stops, 1)).toBe(0);
    expect(leadOf(stops, 2)).toBe(2);
    expect(leadOf(stops, 4)).toBe(4);
    expect(leadOf(stops, 5)).toBe(5);
  });

  it("gives every place its own step when notes don't carry, or there are none", () => {
    const ranges = [{ path: "a.ts", note: "Only here." }, { path: "b.ts" }, { path: "c.ts" }];
    expect(stopsOf({ chapters: [{ title: "A", text: "", ranges }] }).map((s) => s.step)).toEqual([0, 1, 2]);
    const plain = ranges.map(({ path }) => ({ path }));
    expect(stopsOf({ chapters: [{ title: "A", text: "", carries: true, ranges: plain }] }).map((s) => s.step)).toEqual([0, 1, 2]);
  });

  it("measures a stop from where it lands, so nothing joins off-screen", () => {
    const at = (...spans: [number, number][]) =>
      stopsOf({ chapters: [{ title: "A", text: "", ranges: spans.map((lines) => ({ path: "a.ts", lines })) }] }).map((s) => s.joined);
    expect(at([10, 200], [205, 210])).toEqual([false, false]);
    expect(at([10, 11], [30, 31], [50, 51], [70, 71])).toEqual([false, true, false, true]);
    expect(at([100, 101], [90, 91])).toEqual([false, false]);
  });
});

describe("sameStop", () => {
  const chapter = (title: string, ...paths: string[]) => ({ title, text: "", ranges: paths.map((path) => ({ path })) });
  const a = chapter("A", "a.ts");
  const b = chapter("B", "b.ts", "other.ts");
  const c = chapter("C", "c.ts");

  it("follows a chapter when the ones before it leave", () => {
    expect(sameStop({ chapters: [a, b, c] }, { chapters: [c] }, 3)).toBe(0);
    expect(sameStop({ chapters: [a, b, c] }, { chapters: [b, c] }, 2)).toBe(1);
  });

  it("drops the position when its chapter is gone, or is now a different one", () => {
    expect(sameStop({ chapters: [a, c] }, { chapters: [c] }, 0)).toBeNull();
    expect(sameStop({ chapters: [a, b] }, { chapters: [a, chapter("B", "elsewhere.ts")] }, 1)).toBeNull();
    expect(sameStop({ chapters: [a] }, { chapters: [a] }, 5)).toBeNull();
  });

  it("tells apart chapters that share a title", () => {
    const tests = (path: string) => chapter("Tests", path);
    expect(sameStop({ chapters: [tests("a.test.ts"), tests("b.test.ts")] }, { chapters: [tests("b.test.ts")] }, 1)).toBe(0);
  });
});

describe("walking the steps", () => {
  const notes: AgentNotes = {
    chapters: [
      {
        title: "Read",
        text: "Why.",
        carries: true,
        ranges: [
          { path: "a.ts", lines: [1, 2], note: "One." },
          { path: "a.ts", lines: [5, 6] },
          { path: "b.ts", note: "Two.", warn: true },
        ],
      },
      { title: "Tests", text: "", skim: true, ranges: [{ path: "a.test.ts" }] },
      { title: "More", text: "Plain.", warn: true, ranges: [{ path: "c.ts" }, { path: "d.ts" }] },
    ],
  };
  const stops = stopsOf(notes);
  const pass = (s: { chapter: number }) => s.chapter === 1;

  it("passes joined stops and whatever the caller skips, both ways", () => {
    expect(nextStop(stops, null, 1, pass)).toBe(0);
    expect(nextStop(stops, 0, 1, pass)).toBe(2);
    expect(nextStop(stops, 2, 1, pass)).toBe(4);
    expect(nextStop(stops, 4, -1, pass)).toBe(2);
    expect(nextStop(stops, 2, -1, pass)).toBe(0);
    expect(nextStop(stops, 1, -1, pass)).toBe(0);
    expect(nextStop(stops, null, -1, pass)).toBe(5);
    expect(nextStop(stops, 5, 1, pass)).toBeNull();
  });

  it("moves by step, landing back on a step's first place", () => {
    const ranges = [{ path: "a.ts", note: "One." }, { path: "b.ts" }, { path: "c.ts", note: "Two." }, { path: "d.ts" }, { path: "e.ts" }];
    const list = stopsOf({ chapters: [{ title: "A", text: "", carries: true, ranges }] });
    const none = () => false;
    expect(nextStep(list, null, 1, none)).toBe(0);
    expect(nextStep(list, 0, 1, none)).toBe(2);
    expect(nextStep(list, 1, 1, none)).toBe(2);
    expect(nextStep(list, 2, 1, none)).toBeNull();
    expect(nextStep(list, 4, -1, none)).toBe(0);
    expect(nextStep(list, null, -1, none)).toBe(2);
    expect(nextStep(list, 0, 1, (_, i) => i === 2)).toBe(3);
    expect(stepCount(list)).toBe(2);
  });

  it("carries a note over the ranges after it, and captions with the chapter when there is none", () => {
    expect(stepNote(notes.chapters[0], 1)).toBe("One.");
    expect(captionOf(notes, stops, 1)).toEqual({
      chapter: 1,
      chapters: 3,
      title: "Read",
      step: 1,
      steps: 2,
      place: 1,
      places: 1,
      sameFile: 2,
      text: "One.",
      warn: false,
    });
    expect(captionOf(notes, stops, 2)).toMatchObject({ step: 2, text: "Two.", warn: true });
    expect(captionOf(notes, stops, 4)).toMatchObject({ chapter: 3, steps: 2, text: "Plain." });
  });

  it("keeps a note from older notes to its own range", () => {
    const chapter = { title: "A", text: "Why.", ranges: [{ path: "a.ts", note: "One." }, { path: "b.ts" }, { path: "c.ts", note: "Three." }] };
    const old = { chapters: [chapter] };
    const at = stopsOf(old);
    expect(stepNote(chapter, 1)).toBeUndefined();
    expect(at.map((s) => s.step)).toEqual([0, 1, 2]);
    expect(captionOf(old, at, 1)).toMatchObject({ text: "Why.", step: 2, steps: 3 });
    expect(captionOf(old, at, 2)).toMatchObject({ text: "Three.", step: 3 });
  });

  it("counts the places a far-flung step lands on", () => {
    const far = { chapters: [{ title: "A", text: "", carries: true, ranges: [{ path: "a.ts", note: "One." }, { path: "b.ts" }, { path: "c.ts" }] }] };
    expect(captionOf(far, stopsOf(far), 1)).toMatchObject({ place: 2, places: 3, sameFile: 1 });
  });

  it("keeps a warning to its own stop", () => {
    const ranges = [
      { path: "a.ts", lines: [4, 4] as [number, number], note: "Line four.", warn: true },
      { path: "a.ts", lines: [150, 150] as [number, number] },
    ];
    const notes = { chapters: [{ title: "A", text: "", ranges }] };
    const stops = stopsOf(notes);
    expect(captionOf(notes, stops, 0)).toMatchObject({ warn: true, sameFile: 1 });
    expect(captionOf(notes, stops, 1)).toMatchObject({ warn: false, sameFile: 1 });
  });

  it("lists a warned range under its step's sentence, and a warned chapter once", () => {
    expect(checksOf(notes, stops)).toEqual([
      { stop: 2, title: "Read", text: "Two." },
      { stop: 4, title: "More", text: "Plain." },
    ]);
    const ranges = [
      { path: "a.ts", note: "Step." },
      { path: "b.ts", warn: true },
    ];
    const carried = { chapters: [{ title: "A", text: "Blurb.", carries: true, ranges }] };
    expect(checksOf(carried, stopsOf(carried))).toEqual([{ stop: 1, title: "A", text: "Step." }]);
  });
});

describe("whitespaceOnly", () => {
  const of = (body: string[], extra: Partial<FileDiff> = {}) => [{ file: { ...chapterFile, hunks: [diffHunk(1, body)], ...extra }, lines: null }];

  it.each([
    ["shell", "run.sh"],
    ["Dockerfile", "Dockerfile"],
    ["Lua", "a.lua"],
    ["Nix", "a.nix"],
    ["Ruby", "a.rb"],
    ["OCaml", "a.ml"],
    ["SQL", "a.sql"],
    ["Scala", "a.scala"],
  ])("won't vouch for %s, whose strings it can't see", (_name, path) => {
    expect(whitespaceOnly(of(["-  a", "+    a"], { path }))).toBe(false);
  });

  it("won't call a space after a line-ending backslash whitespace", () => {
    expect(whitespaceOnly(of(["-#define A \\\\", "+#define A \\\\ "], { path: "a.c" }))).toBe(false);
    expect(whitespaceOnly(of([" #define A \\\\", "-  b", "+    b"], { path: "a.c" }))).toBe(false);
  });

  it("spots reindents, trailing spaces and blank lines, not edits", () => {
    expect(whitespaceOnly(of(["-  a();", "+    a();", " same"]))).toBe(true);
    expect(whitespaceOnly(of(["-a();  ", "+a();", "+", "+ "]))).toBe(true);
    expect(whitespaceOnly(of(["-  a();", "+  b();"]))).toBe(false);
    expect(whitespaceOnly(of(["+  a();"]))).toBe(false);
  });

  it.each<[string, string[], Partial<FileDiff>?]>([
    ["a space inside a line", ['-run("rm -rf /tmp/ foo");', '+run("rm -rf /tmp/foo");']],
    ["a line break", ["-  return x;", "+  return", "+    x;"]],
    ["a no-break space inside a line", ["-a b", "+a\u00a0b"]],
    ["a no-break space before a line", ["-a", "+\u00a0a"]],
    ["text that couldn't be decoded", ["-caf\uFFFD", "+caf\uFFFD"]],
    ["a changed file mode", ["-  a();", "+    a();"], { oldMode: "100644", newMode: "100755" }],
    ["a file type it can't place", ["-  a", "+    a"], { path: "bin/run" }],
    ["text in a template string", [" const sql = `", "-  drop", "+    drop", " `;"]],
    ["text in a heredoc-style string", [' doc = """', "-  a", "+    a"], { path: "a.rb" }],
    ["a rename", ["-  a();", "+    a();"], { status: "renamed" }],
  ])("doesn't call %s whitespace", (_name, body, extra) => {
    expect(whitespaceOnly(of(body, extra))).toBe(false);
  });

  it("doesn't mistake a line moved past unchanged code for a reindent", () => {
    expect(whitespaceOnly(of(["-  guard();", "   charge();", "   log();", "+  guard();"]))).toBe(false);
    expect(whitespaceOnly(of(["-a();", "-b();", "+b();", "+a();"]))).toBe(false);
    expect(whitespaceOnly(of(["-  a();", "+    a();", " same", "-  b();", "+    b();"]))).toBe(true);
    expect(whitespaceOnly(of(["-", " same", "+"]))).toBe(true);
  });

  it("vouches only for languages the diff view also treats as free of indentation", () => {
    for (const lang of OUTER_SPACE_IS_FREE) expect(spacingOf(lang), lang).toBe("free");
  });

  it("doesn't count an unread or empty chapter", () => {
    expect(whitespaceOnly([{ file: { ...chapterFile, hunks: [] }, lines: null }])).toBe(false);
    expect(whitespaceOnly([])).toBe(false);
  });
});

describe("firstStopLeft", () => {
  const notes = { chapters: [{ title: "A", text: "", ranges: [{ path: "a.ts" }, { path: "b.ts" }, { path: "c.ts" }] }] };
  const stops = stopsOf(notes);

  it("skips staged ranges and files this view doesn't show", () => {
    const shown = new Set(["b.ts", "c.ts"]);
    expect(firstStopLeft(notes, stops, 0, new Map(), shown)).toBe(1);
    expect(firstStopLeft(notes, stops, 0, new Map([[1, "full"]]), shown)).toBe(2);
  });

  it("falls back to the first range when nothing is left", () => {
    expect(firstStopLeft(notes, stops, 0, new Map(), new Set())).toBe(0);
  });
});

describe("holdsMultilineText", () => {
  const sides = (a: string | null, b: string | null) => ({ a, b, hidden: false });

  it("finds a string or heredoc anywhere in either side", () => {
    expect(holdsMultilineText(sides("a();\n", "  a();\n"))).toBe(false);
    expect(holdsMultilineText(sides(null, "const q = `\n  x\n`;\n"))).toBe(true);
    expect(holdsMultilineText(sides('doc = """\n', null))).toBe(true);
    expect(holdsMultilineText(sides("cat <<EOF\n  a: 1\nEOF\n", "cat <<EOF\n    a: 1\nEOF\n"))).toBe(true);
    expect(holdsMultilineText(sides("cat <<-'EOF'\n", "cat << EOF\n"))).toBe(true);
    expect(holdsMultilineText(sides("x = 1 << 2;\n", "x = 1 << 2;\n"))).toBe(false);
  });

  it("finds a plain quote left open across lines, and markup that keeps its spacing", () => {
    expect(holdsMultilineText(sides('let help = "first\n    second\nthird";\n', null))).toBe(true);
    expect(holdsMultilineText(sides("echo 'first\n  second'\n", null))).toBe(true);
    expect(holdsMultilineText(sides("<pre>\n  a\n</pre>\n", null))).toBe(true);
    expect(holdsMultilineText(sides("#define A \\\n  b\n", null))).toBe(true);
    expect(holdsMultilineText(sides("say(\"done\");\n// don't retry\nit's('fine');\n", null))).toBe(false);
  });

  it("can't vouch for a file it wasn't given", () => {
    expect(holdsMultilineText({ a: null, b: null, hidden: true })).toBe(true);
    expect(holdsMultilineText(sides(null, null))).toBe(true);
    expect(holdsMultilineText(sides(null, "const a = 1;"))).toBe(false);
  });
});

describe("shortNames", () => {
  it("adds only as many folders as it takes to tell paths apart", () => {
    const names = shortNames(["src/search/register.ts", "src/auth/register.ts", "lib/search/register.ts", "README.md"]);
    expect(names.get("src/auth/register.ts")).toBe("auth/register.ts");
    expect(names.get("src/search/register.ts")).toBe("src/search/register.ts");
    expect(names.get("README.md")).toBe("README.md");
  });

  it("stops at a path that's the ending of a longer one", () => {
    const names = shortNames(["a/b.ts", "x/a/b.ts", "b.ts"]);
    expect([...names.values()].sort()).toEqual(["a/b.ts", "b.ts", "x/a/b.ts"]);
  });

  it("stays fast on thousands of paths", () => {
    const paths = Array.from({ length: 5000 }, (_, i) => `vendor/pkg${i % 50}/lib/deep/file${i}/index.ts`);
    const started = performance.now();
    expect(shortNames(paths).get(paths[7])).toBe("file7/index.ts");
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe("skimOf", () => {
  const target = (hunks: FileDiff["hunks"]) => [{ file: { ...chapterFile, hunks }, lines: null }];
  const reindent = target([diffHunk(1, ["-  a();", "+    a();"])]);
  const edit = target([diffHunk(1, ["-  a();", "+  b();"])]);
  const plain = () => true;

  it("won't call a change whitespace unless the whole file rules out a string around it", () => {
    const chapter = { title: "A", text: "", ranges: [{ path: "a" }] };
    expect(skimOf(chapter, reindent, () => false)).toBeNull();
    expect(skimOf({ ...chapter, skim: true }, reindent, () => false)).toBe("agent");
  });

  it("trusts its own check over the agent, and a warning over both", () => {
    expect(skimOf({ title: "A", text: "", ranges: [{ path: "a" }] }, reindent, plain)).toBe("whitespace");
    expect(skimOf({ title: "A", text: "", ranges: [{ path: "a" }] }, edit, plain)).toBeNull();
    expect(skimOf({ title: "A", text: "", skim: true, ranges: [{ path: "a" }] }, edit, plain)).toBe("agent");
    expect(skimOf({ title: "A", text: "", skim: true, ranges: [{ path: "a", warn: true }] }, reindent, plain)).toBeNull();
    expect(skimOf({ title: "A", text: "", skim: true, warn: true, ranges: [{ path: "a" }] }, edit, plain)).toBeNull();
  });
});
describe("rows for a range", () => {
  const one: FileDiff = { ...chapterFile, hunks: [chapterHunks[0]] };
  const contents = { a: chapterText.join("\n"), b: chapterText.with(9, "line ten").join("\n"), hidden: false };

  it("finds changed lines and the fold hiding context lines", () => {
    for (const layout of ["split", "unified"] as const) {
      const rows = buildRows(one, contents, { layout, scope: "changed", expanded: new Set() });
      expect(rows[rowOfLine(rows, 10)]).toMatchObject({ kind: layout === "split" ? "chg" : "add" });
      expect(rowOfLine(rows, 25)).toBe(-1);
      expect(lineKeys(rows, one.hunks, 25)).toEqual(["gap1"]);
      const open = buildRows(one, contents, { layout, scope: "changed", expanded: new Set(["gap1"]) });
      expect(rowOfLine(open, 25)).toBeGreaterThan(0);
    }
  });
});

describe("hunkAt", () => {
  const hunks = [
    { newStart: 10, newLines: 5 },
    { newStart: 40, newLines: 0 },
    { newStart: 80, newLines: 2 },
  ] as Hunk[];

  it.each([
    ["inside a hunk", 12, 12, 0, true],
    ["reaching one from unchanged lines", 5, 11, 0, true],
    ["reaching a deletion on the line after it", 41, 41, 1, true],
    ["on unchanged lines, naming the next hunk", 50, 60, 2, false],
    ["below every hunk, naming the last", 90, 95, 2, false],
  ])("finds the hunk for a range %s", (_, start, end, hunk, inside) => {
    expect(hunkAt(hunks, { start, end })).toMatchObject({ hunk, inside });
  });
});

describe("rowToShow", () => {
  const uni = (kind: "ctx" | "del", b?: number) => ({ t: "uni", kind, b }) as Row;

  it("starts at the deleted rows above a line, since that's what the step is about", () => {
    const rows = [uni("ctx", 1), uni("del"), uni("del"), uni("ctx", 2)];
    expect(rowToShow(rows, 3)).toBe(1);
    expect(rowToShow(rows, 0)).toBe(0);
  });

  it("keeps the line on screen below a deletion taller than a screen", () => {
    expect(rowToShow([...Array.from({ length: 40 }, () => uni("del")), uni("ctx", 2)], 40)).toBe(30);
  });
});

describe("rowNotes", () => {
  const marks = [
    { chapter: 0, stop: 0, lead: 0, title: "One", start: 3, end: 8 },
    { chapter: 1, stop: 1, lead: 1, title: "Two", start: 5, end: 5 },
    { chapter: 1, stop: 2, lead: 2, title: "Two", start: 7, end: 9 },
  ];
  const line = (b: number) => ({ t: "uni", kind: "ctx", b }) as Row;
  const del = { t: "uni", kind: "del" } as Row;
  const head = { t: "hunk" } as Row;
  const classes = (rows: Row[], chapter: number | null, stop: number | null) => rowNotes(rows, marks, chapter, stop).map((n) => n?.cls ?? "");

  it("prefers the current stop, then its chapter", () => {
    const rows = [2, 3, 4, 5, 6].map(line);
    expect(classes(rows, null, null)).toEqual(["", "noted noted-top", "noted", "noted", "noted noted-bot"]);
    expect(classes(rows, 1, 1)[3]).toBe("noted in-chapter note-now noted-top noted-bot");
    expect(classes(rows, 0, 0)[3]).toBe("noted in-chapter note-now");
  });

  it("carries deleted lines into the range of the line after them", () => {
    const notes = rowNotes([line(3), del, line(4), del, line(10)], marks, null, null);
    expect(notes.map((n) => n?.mark.stop ?? null)).toEqual([0, 0, 0, null, null]);
    expect(notes.map((n) => n?.first ?? false)).toEqual([true, false, false, false, false]);
  });

  it("keeps a deletion at the end of the file with the range above it", () => {
    const notes = rowNotes([line(3), del, del, head, line(30)], marks, null, null);
    expect(notes.map((n) => n?.mark.stop ?? null)).toEqual([0, 0, 0, null, null]);
  });

  it("numbers each visible piece of a range", () => {
    const notes = rowNotes([line(3), line(4), head, line(6)], marks, null, null);
    expect(notes.map((n) => n?.first ?? null)).toEqual([true, false, null, true]);
  });
});

describe("noteSpans", () => {
  it("splits inline code out of the text", () => {
    expect(noteSpans("Calls `fetch` twice, see `retry()`.")).toEqual([
      { code: false, text: "Calls " },
      { code: true, text: "fetch" },
      { code: false, text: " twice, see " },
      { code: true, text: "retry()" },
      { code: false, text: "." },
    ]);
  });
});
