import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { uncovered } from "../shared/chapters";
import { diff } from "./git";
import { notesPath, parseNotes, readNotes, readRangeNotes, screenshotPath } from "./notes";
import { makeRepo, seed, WIN } from "./test-repo";

describe("parseNotes", () => {
  it("keeps chapters in order and normalizes their ranges", () => {
    const { notes, problem } = parseNotes(
      JSON.stringify({
        summary: " Retries failed fetches. ",
        chapters: [
          {
            title: "Retry",
            text: "Backs off.",
            warn: true,
            ranges: ["./src/a.ts", { path: "src/b.ts", lines: [9, 4], note: " Why. ", warn: true }, { path: "src/c.ts", lines: 7, code: "  return x;" }],
          },
        ],
      }),
    );
    expect(problem).toBeUndefined();
    expect(notes).toEqual({
      summary: "Retries failed fetches.",
      chapters: [
        {
          title: "Retry",
          text: "Backs off.",
          warn: true,
          ranges: [
            { path: "src/a.ts" },
            { path: "src/b.ts", lines: [4, 9], note: "Why.", warn: true },
            { path: "src/c.ts", lines: [7, 7], code: "  return x;" },
          ],
        },
      ],
    });
  });

  it("keeps what was asked, the decisions and skim marks, and drops what isn't text", () => {
    const { notes } = parseNotes(
      JSON.stringify({ asked: " Add retries. ", decisions: [" Kept POST as is. ", 3, " "], chapters: [{ title: "T", skim: true, ranges: ["a.ts"] }] }),
    );
    expect(notes).toMatchObject({ asked: "Add retries.", decisions: ["Kept POST as is."], chapters: [{ title: "T", skim: true }] });
    expect(parseNotes(JSON.stringify({ decisions: "no", chapters: [] })).notes).not.toHaveProperty("decisions");
  });

  it("keeps sections on the notes and on chapters, and drops empty ones", () => {
    const { notes } = parseNotes(
      JSON.stringify({
        sections: [{ title: "Why", body: " Text. " }, { title: "Only a title" }, "no", { before: "a", after: "b", extra: 1 }],
        chapters: [{ title: "T", ranges: ["a.ts"], sections: [{ after: "b" }] }],
      }),
    );
    expect(notes?.sections).toEqual([
      { title: "Why", body: "Text." },
      { before: "a", after: "b" },
    ]);
    expect(notes?.chapters[0].sections).toEqual([{ after: "b" }]);
  });

  it("skips chapters it can't show, and leaves out a range with unusable lines instead of widening it to the whole file", () => {
    const ranges = [
      { text: "no path" },
      "a.ts",
      { path: "b.ts", lines: [0] },
      { path: "c.ts", lines: [0, 3] },
      { path: "d.ts", lines: "10-20" },
      { path: "e.ts", lines: [2, 2] },
      { path: "f.ts", lines: null },
    ];
    const { notes, problem } = parseNotes(JSON.stringify({ chapters: [{ title: "No ranges", ranges: [] }, { ranges: ["a.ts"] }, { title: "Ok", ranges }] }));
    expect(notes?.chapters).toEqual([{ title: "Ok", text: "", ranges: [{ path: "a.ts" }, { path: "e.ts", lines: [2, 2] }, { path: "f.ts" }] }]);
    expect(problem).toBe(
      "Skipped 2 chapters without a title or any ranges in notes.json. Left out 3 ranges whose lines aren't [first, last] counting from 1 in notes.json",
    );
  });

  it("hands a left-out range's sentence to the next range, which would otherwise take the step before", () => {
    const ranges = [
      { path: "a.ts", lines: [1, 2], note: "A" },
      { path: "b.ts", lines: [0, 4], note: "B" },
      { path: "c.ts", lines: [5, 6] },
      { path: "d.ts", lines: [0, 4], note: "D" },
      { path: "e.ts", lines: [5, 6], note: "E" },
    ];
    const { notes } = parseNotes(JSON.stringify({ format: 2, chapters: [{ title: "T", ranges }] }));
    expect(notes?.chapters[0].ranges).toEqual([
      { path: "a.ts", lines: [1, 2], note: "A" },
      { path: "c.ts", lines: [5, 6], note: "B" },
      { path: "e.ts", lines: [5, 6], note: "E" },
    ]);
  });

  it("doesn't hand on a sentence that belonged to its own range in older notes", () => {
    const ranges = [{ path: "a.ts", lines: [0, 1], note: "Gone." }, { path: "b.ts" }];
    const { notes } = parseNotes(JSON.stringify({ chapters: [{ title: "T", ranges }] }));
    expect(notes?.chapters[0].ranges).toEqual([{ path: "b.ts" }]);
    expect(notes?.chapters[0].carries).toBeUndefined();
  });

  it("keeps a chapter's screenshots, from names or objects", () => {
    const { notes } = parseNotes(
      JSON.stringify({
        chapters: [{ title: "A", ranges: ["a.ts"], screenshots: ["a.png", { file: "b.png", caption: " Dark. " }, { caption: "no file" }, 3] }],
      }),
    );
    expect(notes?.chapters[0].screenshots).toEqual([{ file: "a.png" }, { file: "b.png", caption: "Dark." }]);
  });

  it("reports broken files", () => {
    expect(parseNotes("{").problem).toMatch(/isn't valid JSON/);
    expect(parseNotes('{"notes": []}').problem).toMatch(/"chapters" list/);
  });
});

describe("readNotes", () => {
  it("reads notes from the repo's git folder", async () => {
    const r = seed({ "a.ts": "a\n" });
    expect(await readNotes(r.root)).toMatchObject({ notes: null });
    const path = await notesPath(r.root);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ chapters: [{ title: "Hi", ranges: ["a.ts"] }] }));
    expect(path).toBe(join(r.root, ".git", "moire", "notes.json"));
    expect((await readNotes(r.root)).notes?.chapters).toHaveLength(1);
  });

  const setup = async (files: string[]) => {
    const r = seed(Object.fromEntries(files.map((name) => [name, "one\n"])));
    const path = await notesPath(r.root);
    mkdirSync(dirname(path), { recursive: true });
    const write = (notes: unknown) => writeFileSync(path, typeof notes === "string" ? notes : JSON.stringify(notes));
    const working = async () => (await readNotes(r.root)).notes?.chapters.map((c) => c.title) ?? [];
    const committed = async (rev = "HEAD") => (await readNotes(r.root, rev)).notes?.chapters.map((c) => c.title) ?? [];
    return { r, path, write, working, committed };
  };
  const chapter = (title: string, path: string, lines?: [number, number], code?: string) => ({ title, text: "", ranges: [{ path, lines, code }] });

  it("moves committed chapters to their commit and keeps the rest", async () => {
    const { r, path, write, working, committed } = await setup(["a.ts", "b.ts", "c.ts"]);
    for (const name of ["a.ts", "b.ts", "c.ts"]) r.write(name, "two\n");
    write({ summary: "S", chapters: [chapter("A", "a.ts", [1, 1]), chapter("B", "b.ts", [1, 1]), chapter("C", "c.ts", [1, 1])] });
    expect(await working()).toEqual(["A", "B", "C"]);

    r.git("add", "a.ts");
    r.git("commit", "-qm", "a");
    r.git("checkout", "c.ts");
    expect(await working()).toEqual(["B", "C"]);
    const file = await readNotes(r.root, "HEAD");
    expect(file.path).toBe(join(r.root, ".git", "moire", "commits", `${r.git("rev-parse", "HEAD")}.json`));
    expect(file.notes).toEqual({ summary: "S", chapters: [{ title: "A", text: "", ranges: [{ path: "a.ts", lines: [1, 1] }] }] });

    r.git("commit", "-qam", "b");
    expect(await committed()).toEqual(["B"]);
    expect(await working()).toEqual(["C"]);
    r.write("c.ts", "three\n");
    r.git("commit", "-qam", "c");
    expect(await committed()).toEqual(["C"]);
    expect(existsSync(path)).toBe(false);
  });

  it("follows a chapter's code when deciding whether it's done", async () => {
    const { r, write, working } = await setup(["a.ts"]);
    const original = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    r.write("a.ts", original.join("\n") + "\n");
    r.commit("a");
    const lines = original.with(19, "CHANGED");
    r.write("a.ts", lines.join("\n") + "\n");
    write({ chapters: [chapter("X", "a.ts", [20, 20], "CHANGED")] });
    expect(await working()).toEqual(["X"]);
    const moved = ["new", "new", "new", "new", "new"];
    r.write("a.ts", [...moved, ...original].join("\n") + "\n");
    r.git("add", "a.ts");
    r.git("commit", "-qm", "lines above it");
    r.write("a.ts", [...moved, ...lines].join("\n") + "\n");
    expect(await working()).toEqual(["X"]);
  });

  it("leaves chapters alone when HEAD moves past commits made elsewhere", async () => {
    const { r, write, working, committed } = await setup(["a.ts"]);
    const original = Array.from({ length: 20 }, (_, i) => `line ${i + 1}\n`);
    r.write("a.ts", original.join(""));
    r.commit("a");
    r.write("a.ts", ["upstream\n", ...original.slice(1)].join(""));
    r.git("add", "a.ts");
    const theirs = r.git("commit-tree", r.git("write-tree"), "-p", "HEAD", "-m", "upstream");
    r.git("reset", "-q", "--hard");
    r.git("update-ref", "refs/heads/up", theirs);
    r.write("a.ts", [...original.slice(0, -1), "mine\n"].join(""));
    write({ chapters: [chapter("A", "a.ts")] });
    expect(await working()).toEqual(["A"]);
    r.git("stash", "-q");
    r.git("merge", "-q", "--ff-only", "up");
    expect(await working()).toEqual(["A"]);
    r.git("stash", "pop", "-q");
    expect(await working()).toEqual(["A"]);
    expect(await committed()).toEqual([]);
  });

  it("files each chapter under the commit that finished it", async () => {
    const { r, write, working, committed } = await setup(["a.ts", "b.ts"]);
    r.write("a.ts", "two\n");
    r.write("b.ts", "two\n");
    write({ chapters: [chapter("A", "a.ts"), chapter("B", "b.ts")] });
    expect(await working()).toEqual(["A", "B"]);
    r.git("commit", "-qm", "a", "--", "a.ts");
    r.git("commit", "-qm", "b", "--", "b.ts");
    expect(await working()).toEqual([]);
    expect(await committed("HEAD~1")).toEqual(["A"]);
    expect(await committed()).toEqual(["B"]);
  });

  it.each(["rebase-merge", "rebase-apply", "MERGE_HEAD", "MERGE_AUTOSTASH", "CHERRY_PICK_HEAD", "REVERT_HEAD", "index.lock"])(
    "waits for a commit to settle while %s is there",
    async (name) => {
      const { r, write, working, committed } = await setup(["a.ts"]);
      r.write("a.ts", "two\n");
      write({ chapters: [chapter("A", "a.ts")] });
      expect(await working()).toEqual(["A"]);
      r.git("commit", "-qam", "a");
      writeFileSync(join(r.root, ".git", name), "");
      expect(await working()).toEqual(["A"]);
      rmSync(join(r.root, ".git", name));
      expect(await working()).toEqual([]);
      expect(await committed()).toEqual(["A"]);
    },
  );

  it("settles a commit made while notes.json was half written", async () => {
    const { r, write, working, committed } = await setup(["a.ts"]);
    expect(await working()).toEqual([]);
    r.write("a.ts", "two\n");
    write('{"chapters": [');
    r.git("commit", "-qam", "a");
    expect((await readNotes(r.root)).problem).toMatch(/isn't valid JSON/);
    write({ chapters: [chapter("A", "a.ts")] });
    expect(await working()).toEqual([]);
    expect(await committed()).toEqual(["A"]);
  });

  it("settles the first commit of a new repo and commits made before moire looked", async () => {
    const r = makeRepo();
    const path = await notesPath(r.root);
    expect((await readNotes(r.root)).notes).toBeNull();
    mkdirSync(dirname(path), { recursive: true });
    r.write("a.ts", "one\n");
    writeFileSync(path, JSON.stringify({ chapters: [chapter("A", "a.ts")] }));
    r.commit("init");
    expect((await readNotes(r.root)).notes).toBeNull();
    expect((await readNotes(r.root, "HEAD")).notes?.chapters).toHaveLength(1);

    const fresh = seed({ "a.ts": "one\n" });
    const freshPath = await notesPath(fresh.root);
    mkdirSync(dirname(freshPath), { recursive: true });
    fresh.write("a.ts", "two\n");
    writeFileSync(freshPath, JSON.stringify({ chapters: [chapter("A", "a.ts")] }));
    fresh.git("commit", "-qam", "a");
    expect((await readNotes(fresh.root)).notes).toBeNull();
    expect((await readNotes(fresh.root, "HEAD")).notes?.chapters).toHaveLength(1);
  });

  it("keeps each chapter's note format as it moves between files", async () => {
    const { r, path, write, committed } = await setup(["a.ts", "b.ts"]);
    const carrying = (title: string, name: string) => ({ title, text: "", ranges: [{ path: name, note: "N" }] });
    r.write("a.ts", "two\n");
    write({ format: 2, chapters: [carrying("New", "a.ts")] });
    await readNotes(r.root);
    r.git("add", "a.ts");
    r.git("commit", "-qm", "one");
    expect(await committed()).toEqual(["New"]);
    expect(existsSync(path)).toBe(false);
    expect((await readNotes(r.root, "HEAD")).notes?.chapters[0].carries).toBe(true);

    r.write("b.ts", "two\n");
    write({ chapters: [carrying("Old", "b.ts")] });
    await readNotes(r.root);
    r.git("add", "b.ts");
    r.git("commit", "--amend", "-qm", "one");
    expect((await readNotes(r.root, "HEAD")).notes?.chapters.map((c) => [c.title, !!c.carries])).toEqual([
      ["New", true],
      ["Old", false],
    ]);

    r.git("reset", "-q", "--soft", "HEAD~1");
    r.git("reset", "-q");
    write({ format: 2, chapters: [] });
    expect((await readNotes(r.root)).notes?.chapters.map((c) => [c.title, !!c.carries])).toEqual([
      ["New", true],
      ["Old", false],
    ]);
  });

  it("tells a warning on unchanged lines from one on lines that changed", async () => {
    const { r, write } = await setup(["a.ts", "b.ts", "c.ts"]);
    r.write("a.ts", "one\ntwo\nthree\nfour\nfive\nsix\nseven\nchanged\n");
    r.git("add", "a.ts");
    r.git("commit", "-qm", "base");
    await readNotes(r.root);
    r.write("a.ts", "one\ntwo\nthree\nfour\nfive\nsix\nseven\nedited\n");
    r.write("c.ts", "two\n");
    r.git("add", "c.ts");
    write({
      format: 2,
      chapters: [
        { title: "Quiet line", text: "", ranges: [{ path: "a.ts", lines: [1, 1], warn: true }] },
        { title: "Quiet file", text: "", warn: true, ranges: [{ path: "b.ts" }] },
        { title: "Staged", text: "", warn: true, ranges: [{ path: "c.ts" }] },
        { title: "Changed", text: "", ranges: [{ path: "a.ts", lines: [8, 8], warn: true }] },
      ],
    });
    expect((await readNotes(r.root)).standing).toEqual([[0], [0], [], []]);
    write({ format: 2, chapters: [{ title: "Plain", text: "", ranges: [{ path: "a.ts" }] }] });
    expect((await readNotes(r.root)).standing).toBeUndefined();
  });

  describe("a warning on lines nobody changed", () => {
    const quiet = (path: string) => ({ title: "Quiet", text: "", ranges: [{ path, lines: [1, 1] as [number, number], warn: true }] });
    const age = (path: string) => utimesSync(path, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));

    it("isn't settled onto a commit made before the notes, even in the same second", async () => {
      const { r, write, working, committed } = await setup(["a.ts"]);
      write({ format: 2, chapters: [quiet("a.ts")] });
      expect(await working()).toEqual(["Quiet"]);
      expect((await readNotes(r.root)).standing).toEqual([[0]]);
      expect(await committed()).toEqual([]);
    });

    it("stays when the file was committed just before the notes were written", async () => {
      const { r, write, working, committed } = await setup(["a.ts"]);
      await readNotes(r.root);
      r.write("a.ts", "one\ntwo\n");
      r.git("add", "a.ts");
      r.git("commit", "-qm", "two");
      write({ format: 2, chapters: [quiet("a.ts")] });
      expect(await working()).toEqual(["Quiet"]);
      expect(await committed()).toEqual([]);
    });

    it("moves to the commit that comes after it, without losing it", async () => {
      const { r, path, write, working, committed } = await setup(["a.ts", "b.ts"]);
      await readNotes(r.root);
      write({ format: 2, chapters: [quiet("a.ts")] });
      expect(await working()).toEqual(["Quiet"]);
      age(path);
      r.write("b.ts", "two\n");
      r.git("add", "b.ts");
      r.git("commit", "-qm", "unrelated");
      expect(await working()).toEqual([]);
      expect(await committed()).toEqual(["Quiet"]);
    });

    it("comes back when the commit it went with is undone", async () => {
      const { r, path, write, working, committed } = await setup(["a.ts", "b.ts"]);
      await readNotes(r.root);
      r.write("b.ts", "two\n");
      write({ asked: "Why.", format: 2, chapters: [chapter("B", "b.ts"), quiet("a.ts")] });
      age(path);
      r.git("add", "b.ts");
      r.git("commit", "-qm", "b");
      expect(await working()).toEqual([]);
      expect(await committed()).toEqual(["B", "Quiet"]);

      r.git("reset", "-q", "--soft", "HEAD~1");
      expect(await working()).toEqual(["B", "Quiet"]);
      expect((await readNotes(r.root)).standing).toEqual([[], [0]]);
    });

    it("goes with a commit that changed those very lines when that commit is thrown away", async () => {
      const { r, write, working, committed } = await setup(["a.ts"]);
      await readNotes(r.root);
      r.write("a.ts", "two\n");
      r.git("add", "a.ts");
      r.git("commit", "-qm", "two");
      write({ format: 2, chapters: [quiet("a.ts")] });
      expect(await committed()).toEqual(["Quiet"]);
      r.git("reset", "-q", "--hard", "HEAD~1");
      expect(await working()).toEqual([]);
    });

    it("still goes with a commit that changed those very lines", async () => {
      const { r, write, working, committed } = await setup(["a.ts"]);
      await readNotes(r.root);
      r.write("a.ts", "two\n");
      r.git("add", "a.ts");
      r.git("commit", "-qm", "two");
      write({ format: 2, chapters: [quiet("a.ts")] });
      expect(await working()).toEqual([]);
      expect(await committed()).toEqual(["Quiet"]);
    });
  });

  it("carries chapters through an amend, joins both briefs, and brings them back on reset", async () => {
    const { r, write, working, committed } = await setup(["a.ts", "b.ts"]);
    r.write("a.ts", "two\n");
    write({ asked: "First.", decisions: ["D1"], sections: [{ body: "S1" }], chapters: [chapter("A", "a.ts")] });
    expect(await working()).toEqual(["A"]);
    r.git("commit", "-qam", "a");
    expect(await working()).toEqual([]);
    r.git("commit", "-q", "--amend", "-m", "a, reworded");
    expect(await committed()).toEqual(["A"]);

    r.write("b.ts", "two\n");
    write({ asked: "Second.", decisions: ["D1", "D2"], sections: [{ body: "S2" }], chapters: [chapter("B", "b.ts")] });
    expect(await working()).toEqual(["B"]);
    r.git("commit", "-q", "--amend", "-am", "a and b");
    expect(await working()).toEqual([]);
    expect(await committed()).toEqual(["A", "B"]);
    expect((await readNotes(r.root, "HEAD")).notes).toMatchObject({
      asked: "First.\n\nSecond.",
      decisions: ["D1", "D2"],
      sections: [{ body: "S1" }, { body: "S2" }],
    });

    r.git("reset", "-q", "--soft", "HEAD~1");
    expect(await working()).toEqual(["A", "B"]);
  });

  it("moves a brief onto its commit, and restores briefs oldest first when commits are undone", async () => {
    const { r, write, working } = await setup(["a.ts", "b.ts"]);
    const first = { summary: "S", asked: "First.", decisions: ["D1"], sections: [{ body: "More." }] };
    r.write("a.ts", "two\n");
    write({ ...first, chapters: [chapter("A", "a.ts")] });
    expect(await working()).toEqual(["A"]);
    r.git("commit", "-qam", "a");
    expect(await working()).toEqual([]);
    expect((await readNotes(r.root, "HEAD")).notes).toMatchObject(first);
    r.write("b.ts", "two\n");
    write({ asked: "Second.", decisions: ["D2"], chapters: [chapter("B", "b.ts")] });
    expect(await working()).toEqual(["B"]);
    r.git("commit", "-qam", "b");
    expect(await working()).toEqual([]);
    r.git("reset", "-q", "--soft", "HEAD~2");
    expect(await working()).toEqual(["A", "B"]);
    expect((await readNotes(r.root)).notes).toMatchObject({ asked: "First.\n\nSecond.", decisions: ["D1", "D2"], sections: first.sections });
  });

  it("keeps chapters it skipped and fields it doesn't know when rewriting notes.json", async () => {
    const { r, path, write, working } = await setup(["a.ts", "b.ts"]);
    r.write("a.ts", "two\n");
    r.write("b.ts", "two\n");
    write({ extra: 1, chapters: [chapter("A", "a.ts"), { text: "no title yet", ranges: ["b.ts"] }] });
    r.git("commit", "-qm", "a", "--", "a.ts");
    expect(await working()).toEqual([]);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ extra: 1, chapters: [{ text: "no title yet", ranges: ["b.ts"] }] });
  });

  describe("screenshots", () => {
    const save = async (r: ReturnType<typeof makeRepo>, file: string, age = 0) => {
      const path = (await screenshotPath(r.root, file))!;
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "png");
      const at = new Date(Date.now() - age);
      utimesSync(path, at, at);
    };
    const repo = () => {
      const r = makeRepo();
      r.write("a.ts", "one\n");
      r.commit("base");
      r.write("a.ts", "two\n");
      return r;
    };
    const notesWith = async (r: ReturnType<typeof makeRepo>, screenshots: unknown[]) => {
      mkdirSync(dirname(await notesPath(r.root)), { recursive: true });
      writeFileSync(await notesPath(r.root), JSON.stringify({ chapters: [{ title: "A", ranges: ["a.ts"], screenshots }] }));
      return (await readNotes(r.root)).notes!.chapters[0].screenshots!;
    };

    it("stamps a saved image, and flags one the code has moved past or that's missing", async () => {
      const r = repo();
      await save(r, "new.png");
      await save(r, "old.png", 60_000);
      const [fresh, old, gone] = await notesWith(r, ["new.png", "old.png", "gone.png"]);
      expect(fresh.version).toBeGreaterThan(0);
      expect(fresh.stale).toBeUndefined();
      expect(old.stale).toBe(true);
      expect(gone).toEqual({ file: "gone.png", missing: true });
    });

    it("refuses names that aren't plain images in the media folder", async () => {
      const r = repo();
      for (const name of ["../notes.json", "../x.png", "a/b.png", ".hidden.png", "a.txt", "/etc/x.png"]) expect(await screenshotPath(r.root, name)).toBeNull();
    });
  });

  it("gives a moved chapter its commit's line numbers, and the work tree's back on reset", async () => {
    const r = makeRepo();
    const text = (lines: string[]) => lines.join("\n") + "\n";
    const code = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
    r.write("a.ts", text(code));
    r.commit("base");
    await readNotes(r.root);
    const edited = code.map((l, i) => (i === 29 ? "changed" : l));
    r.write("a.ts", text(edited));
    r.git("add", "a.ts");
    r.write("a.ts", text(["n1", "n2", "n3", "n4", "n5", ...edited]));
    writeFileSync(await notesPath(r.root), JSON.stringify({ chapters: [{ title: "A", text: "", ranges: [{ path: "a.ts", lines: [35, 35] }] }] }));
    r.git("commit", "-qm", "only the edit");
    const { notes } = await readNotes(r.root, "HEAD");
    expect(notes?.chapters[0].ranges[0].lines).toEqual([30, 30]);

    r.git("reset", "-q", "--soft", "HEAD~1");
    expect((await readNotes(r.root)).notes?.chapters[0].ranges[0].lines).toEqual([35, 35]);
  });

  it("places ranges in the work tree", async () => {
    const { r, write } = await setup(["a.ts"]);
    r.write("a.ts", "new\none\nadded\n");
    write({
      chapters: [
        { title: "A", ranges: [{ path: "a.ts", lines: [2, 2], code: "added" }, "a.ts", { path: "../x", lines: [1, 1] }, { path: "..\\x", lines: [1, 1] }] },
      ],
    });
    expect((await readNotes(r.root)).placed).toEqual([[{ start: 3, end: 3 }, "all", { start: 1, end: 1 }, { start: 1, end: 1 }]]);
  });
});

describe("readRangeNotes", () => {
  const commitNotes = (r: ReturnType<typeof makeRepo>, sha: string, notes: unknown) => {
    const path = join(r.root, ".git", "moire", "commits", `${sha}.json`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(notes));
  };
  const numbered = (n: number, edit: Record<number, string> = {}) => Array.from({ length: n }, (_, i) => edit[i + 1] ?? `line ${i + 1}`).join("\n") + "\n";
  const branch = (r: ReturnType<typeof makeRepo>) => {
    r.write("a.ts", numbered(30));
    r.commit("base");
    r.git("checkout", "-q", "-b", "feature");
  };
  const range = { kind: "branches", base: "main", head: "feature" } as const;
  const chapter = (title: string, ranges: unknown[]) => ({ title, text: "", ranges });

  it("stitches chapters from each commit in order and counts the commits without notes", async () => {
    const r = makeRepo();
    branch(r);
    r.write("a.ts", numbered(30, { 5: "first" }));
    r.commit("one");
    commitNotes(r, r.git("rev-parse", "HEAD"), { summary: "One", chapters: [chapter("First", [{ path: "a.ts", lines: [5, 5] }])] });
    r.write("a.ts", numbered(30, { 5: "first", 10: "unexplained" }));
    r.commit("two");
    r.write("b.ts", "new\n");
    r.commit("three");
    commitNotes(r, r.git("rev-parse", "HEAD"), { summary: "Three", chapters: [chapter("Third", ["b.ts"])] });

    const file = await readRangeNotes(r.root, range);
    expect(file.notes?.chapters.map((c) => c.title)).toEqual(["First", "Third"]);
    expect(file.notes?.chapters.map((c) => c.from?.subject)).toEqual(["one", "three"]);
    expect(file.notes?.summary).toBeUndefined();
    expect(file.commits).toEqual({ noted: 2, total: 3 });
  });

  it("gathers what each commit was asked and decided, once each", async () => {
    const r = makeRepo();
    branch(r);
    r.write("a.ts", numbered(30, { 5: "first" }));
    r.commit("one");
    commitNotes(r, r.git("rev-parse", "HEAD"), { asked: "Fix it.", decisions: ["Kept A."], chapters: [chapter("First", [{ path: "a.ts", lines: [5, 5] }])] });
    r.write("a.ts", numbered(30, { 5: "first", 10: "second" }));
    r.commit("two");
    commitNotes(r, r.git("rev-parse", "HEAD"), {
      asked: "Fix it.",
      decisions: ["Kept A.", "Kept B."],
      chapters: [chapter("Second", [{ path: "a.ts", lines: [10, 10] }])],
    });
    expect((await readRangeNotes(r.root, range)).notes).toMatchObject({ asked: "Fix it.", decisions: ["Kept A.", "Kept B."] });
  });

  it("hands a step's sentence on when a later commit removes its first range", async () => {
    const r = makeRepo();
    branch(r);
    r.write("a.ts", numbered(30, { 5: "first" }));
    r.write("b.ts", "b\n");
    r.write("c.ts", "c\n");
    r.commit("one");
    commitNotes(r, r.git("rev-parse", "HEAD"), {
      format: 2,
      chapters: [chapter("A", [{ path: "a.ts", lines: [5, 5], note: "ONE" }, { path: "b.ts", note: "TWO" }, { path: "c.ts" }])],
    });
    r.git("rm", "-q", "b.ts");
    r.commit("two");
    const ranges = (await readRangeNotes(r.root, range)).notes?.chapters[0].ranges;
    expect(ranges?.map(({ path, note }) => [path, note])).toEqual([
      ["a.ts", "ONE"],
      ["c.ts", "TWO"],
    ]);
  });

  it("moves line ranges past lines added by later commits", async () => {
    const r = makeRepo();
    branch(r);
    r.write("a.ts", numbered(30, { 20: "chapter line" }));
    r.commit("one");
    commitNotes(r, r.git("rev-parse", "HEAD"), { chapters: [chapter("Line", [{ path: "a.ts", lines: [20, 20], code: "chapter line" }])] });
    r.write("a.ts", "added\nadded\n" + numbered(30, { 20: "chapter line" }));
    r.commit("two");

    const file = await readRangeNotes(r.root, range);
    expect(file.notes?.chapters[0].ranges[0]).toEqual({ path: "a.ts", lines: [22, 22] });
    expect(file.placed).toEqual([[{ start: 22, end: 22 }]]);
  });

  it("drops chapters a later commit undid and follows renames", async () => {
    const r = makeRepo();
    branch(r);
    r.write("a.ts", numbered(30, { 5: "kept" }));
    r.write("gone.ts", "temporary\n");
    r.commit("one");
    commitNotes(r, r.git("rev-parse", "HEAD"), {
      chapters: [chapter("Kept", [{ path: "a.ts", lines: [5, 5] }]), chapter("Undone", ["gone.ts"])],
    });
    r.git("mv", "a.ts", "renamed.ts");
    r.git("rm", "-q", "gone.ts");
    r.commit("two");

    const file = await readRangeNotes(r.root, range);
    expect(file.notes?.chapters.map((c) => c.title)).toEqual(["Kept"]);
    expect(file.notes?.chapters[0].ranges[0].path).toBe("renamed.ts");
  });

  it("keeps a warning on a file the branch never changed, and says it stands", async () => {
    const r = makeRepo();
    r.write("quiet.ts", numbered(10, {}));
    r.commit("base");
    branch(r);
    r.write("a.ts", "a\n");
    r.commit("one");
    commitNotes(r, r.git("rev-parse", "HEAD"), {
      chapters: [chapter("Only a warning", [{ path: "quiet.ts", lines: [5, 5], warn: true, note: "Still calls the old endpoint." }])],
    });

    const file = await readRangeNotes(r.root, range);
    expect(file.notes?.chapters.map((c) => c.title)).toEqual(["Only a warning"]);
    expect(file.standing).toEqual([[0]]);
  });

  const unexplained = async (r: ReturnType<typeof makeRepo>, mode: Parameters<typeof readRangeNotes>[1]) => {
    const { notes, placed } = await readRangeNotes(r.root, mode);
    return uncovered((await diff(r.root, mode)).files, notes ?? { chapters: [] }, placed);
  };

  it.skipIf(WIN)("reports binary, chmod-only and oversized files, but not one hidden as whitespace", async () => {
    const r = makeRepo();
    r.write("logo.bin", Buffer.from([0, 1, 2]));
    r.write("run.sh", "echo\n");
    r.write("big.txt", "x\n");
    r.write("spaces.ts", "a();\n");
    r.commit("base");
    r.write("logo.bin", Buffer.from([0, 1, 3]));
    chmodSync(join(r.root, "run.sh"), 0o755);
    r.write("big.txt", "x".repeat(2 * 1024 * 1024 + 10));
    r.write("spaces.ts", "  a();\n");
    const paths = async (ignoreWhitespace: boolean) => {
      const { files } = await diff(r.root, { kind: "unstaged" }, [], ignoreWhitespace);
      return uncovered(files, { chapters: [] })
        .map((u) => u.path)
        .sort();
    };
    expect(await paths(false)).toEqual(["big.txt", "logo.bin", "run.sh", "spaces.ts"]);
    expect(await paths(true)).toEqual(["big.txt", "logo.bin", "run.sh"]);
  });

  it.each([
    ["in the middle of a file", numbered(30).replace("line 10\n", "")],
    ["alongside an added line", numbered(30).replace("line 10\n", "").replace("line 4\n", "line 4\nadded\n")],
    ["at the end of a file", numbered(29)],
    ["at the top of a file", numbered(30).replace("line 1\n", "")],
  ])("keeps a whole-file chapter whose commit deletes lines %s", async (_, text) => {
    const r = makeRepo();
    branch(r);
    r.write("a.ts", text);
    r.commit("one");
    commitNotes(r, r.git("rev-parse", "HEAD"), { chapters: [chapter("Removes a line", ["a.ts"])] });

    const notes = (await readRangeNotes(r.root, range)).notes;
    expect(notes?.chapters[0].ranges).toEqual([{ path: "a.ts" }]);
    expect(await unexplained(r, range)).toEqual([]);
  });

  it.each([
    ["inserted where the lines went", numbered(30).replace("line 10\n", "stray\nstray 2\n"), 3],
    ["an edit to the next line", numbered(30).replace("line 10\nline 11\n", "stray\n"), 3],
    ["a deletion of the next line", numbered(30).replace("line 10\nline 11\n", ""), 2],
    ["lines added after a deleted end of file", numbered(29) + "stray\nstray 2\n", 3],
  ])("doesn't let a chapter claim %s by a later commit", async (_, later, count) => {
    const r = makeRepo();
    branch(r);
    r.write("a.ts", later.includes("line 30") ? numbered(30).replace("line 10\n", "") : numbered(29));
    r.commit("one");
    commitNotes(r, r.git("rev-parse", "HEAD"), { chapters: [chapter("Removes a line", ["a.ts"])] });
    r.write("a.ts", later);
    r.commit("two");

    expect((await readRangeNotes(r.root, range)).notes?.chapters).toHaveLength(1);
    expect(await unexplained(r, range)).toEqual([{ path: "a.ts", count }]);
  });

  it("keeps a note on a deletion after a later commit removes the line it's anchored to", async () => {
    const r = makeRepo();
    branch(r);
    r.write("a.ts", numbered(30).replace("line 10\n", ""));
    r.commit("one");
    commitNotes(r, r.git("rev-parse", "HEAD"), {
      chapters: [chapter("Removes a line", [{ path: "a.ts", lines: [10, 10], code: "line 11", note: "Gone." }])],
    });
    r.write("a.ts", numbered(30).replace("line 10\nline 11\n", ""));
    r.commit("two");

    const ranges = (await readRangeNotes(r.root, range)).notes?.chapters[0].ranges;
    expect(ranges).toEqual([{ path: "a.ts", lines: [9, 9], note: "Gone." }]);
  });

  it("doesn't let a whole-file range cover the file once that commit's lines are gone", async () => {
    const r = makeRepo();
    branch(r);
    r.write("a.ts", numbered(30).replace("line 5\n", "line 5\nchapter line\n"));
    r.commit("one");
    commitNotes(r, r.git("rev-parse", "HEAD"), { chapters: [chapter("Whole file", ["a.ts"])] });
    r.write("a.ts", numbered(30, { 25: "stray" }));
    r.commit("two");

    expect(await unexplained(r, range)).toEqual([{ path: "a.ts", count: 2 }]);
  });

  it("finds a whole-file range's lines in the earlier commit that made them", async () => {
    const r = makeRepo();
    branch(r);
    r.write("a.ts", numbered(30, { 5: "explained" }));
    r.commit("one");
    r.write("b.ts", "new\n");
    r.commit("two");
    commitNotes(r, r.git("rev-parse", "HEAD"), { chapters: [chapter("Two files", ["a.ts", "b.ts"])] });
    expect(await unexplained(r, range)).toEqual([]);

    r.write("a.ts", numbered(30, { 5: "explained", 25: "stray" }));
    r.commit("three");
    const { notes } = await readRangeNotes(r.root, range);
    expect(notes?.chapters[0].ranges).toEqual([{ path: "a.ts", lines: [5, 5] }, { path: "b.ts" }]);
    expect(await unexplained(r, range)).toEqual([{ path: "a.ts", count: 2 }]);
  });

  it("keeps a whole-file range on a change with no lines, until later lines arrive", async () => {
    const r = makeRepo();
    branch(r);
    r.git("mv", "a.ts", "b.ts");
    r.commit("moved");
    commitNotes(r, r.git("rev-parse", "HEAD"), { chapters: [chapter("Moved", ["b.ts"])] });
    expect((await readRangeNotes(r.root, range)).notes?.chapters[0].ranges).toEqual([{ path: "b.ts" }]);

    r.write("b.ts", numbered(30, { 25: "stray" }));
    r.commit("stray");
    expect(await unexplained(r, range)).toEqual([{ path: "b.ts", count: 2 }]);
  });

  it("limits an uncommitted whole-file range to the uncommitted lines", async () => {
    const r = makeRepo();
    branch(r);
    r.write("a.ts", numbered(30, { 25: "committed, no notes" }));
    r.commit("one");
    r.write("a.ts", numbered(30, { 5: "uncommitted", 25: "committed, no notes" }));
    const notes = await notesPath(r.root);
    mkdirSync(dirname(notes), { recursive: true });
    writeFileSync(notes, JSON.stringify({ chapters: [chapter("Working", ["a.ts"]), chapter("Elsewhere", ["clean.ts"])] }));

    const mode = { ...range, head: "HEAD", worktree: true } as const;
    const file = await readRangeNotes(r.root, mode);
    expect(file.notes?.chapters.map((c) => c.ranges)).toEqual([[{ path: "a.ts", lines: [5, 5] }]]);
    expect(await unexplained(r, mode)).toEqual([{ path: "a.ts", count: 2 }]);
  });

  it("reports notes it can't read instead of showing none", async () => {
    const r = makeRepo();
    branch(r);
    r.write("a.ts", numbered(30, { 5: "changed" }));
    const sha = r.commit("one");
    mkdirSync(join(r.root, ".git", "moire", "commits"), { recursive: true });
    writeFileSync(join(r.root, ".git", "moire", "commits", `${sha}.json`), "{ nope");
    expect((await readRangeNotes(r.root, range)).problem).toContain(`${sha}.json isn't valid JSON`);

    const notes = await notesPath(r.root);
    writeFileSync(notes, "{ nope");
    expect((await readRangeNotes(r.root, { ...range, head: "HEAD", worktree: true })).problem).toContain("notes.json isn't valid JSON");
  });

  it("reports chapters it skipped alongside the ones it shows", async () => {
    const r = makeRepo();
    branch(r);
    r.write("a.ts", numbered(30, { 5: "changed" }));
    const sha = r.commit("one");
    commitNotes(r, sha, { chapters: [chapter("Kept", ["a.ts"]), { title: "No ranges" }] });

    const file = await readRangeNotes(r.root, range);
    expect(file.notes?.chapters.map((c) => c.title)).toEqual(["Kept"]);
    expect(file.problem).toBe(`Skipped 1 chapter without a title or any ranges in ${sha}.json`);
  });

  it("follows a file moved without git add", async () => {
    const r = makeRepo();
    branch(r);
    r.write("a.ts", numbered(30, { 5: "changed" }));
    commitNotes(r, r.commit("one"), { chapters: [chapter("Moved", [{ path: "a.ts", lines: [5, 5] }])] });
    r.git("mv", "a.ts", "b.ts");
    r.git("reset", "-q");
    const { notes } = await readRangeNotes(r.root, { ...range, head: "HEAD", worktree: true });
    expect(notes?.chapters[0].ranges).toEqual([{ path: "b.ts", lines: [5, 5] }]);
  });

  it("adds the uncommitted chapters when the comparison reaches the working tree", async () => {
    const r = makeRepo();
    r.write("a.ts", numbered(30));
    r.commit("base");
    r.write("a.ts", numbered(30, { 5: "committed" }));
    r.commit("one");
    commitNotes(r, r.git("rev-parse", "HEAD"), { chapters: [chapter("Committed", [{ path: "a.ts", lines: [5, 5] }])] });
    r.write("a.ts", "new top\n" + numbered(30, { 5: "committed", 20: "uncommitted" }));
    const notes = await notesPath(r.root);
    mkdirSync(dirname(notes), { recursive: true });
    writeFileSync(notes, JSON.stringify({ chapters: [chapter("Working", [{ path: "a.ts", lines: [21, 21] }])] }));

    const file = await readRangeNotes(r.root, { kind: "branches", base: "HEAD~1", head: "HEAD", worktree: true });
    expect(file.notes?.chapters.map((c) => [c.title, c.from?.subject])).toEqual([
      ["Committed", "one"],
      ["Working", "Uncommitted"],
    ]);
    expect(file.notes?.chapters[0].ranges[0].lines).toEqual([6, 6]);
  });
});
