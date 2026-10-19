import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { notesPath, parseNotes, readNotes } from "./notes";
import { makeRepo } from "./test-repo";

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

  it("skips chapters it can't show and says so", () => {
    const { notes, problem } = parseNotes(
      JSON.stringify({
        chapters: [
          { title: "No ranges", ranges: [] },
          { ranges: ["a.ts"] },
          { title: "Ok", ranges: [{ text: "no path" }, "a.ts", { path: "b.ts", lines: [0] }] },
        ],
      }),
    );
    expect(notes?.chapters).toEqual([{ title: "Ok", text: "", ranges: [{ path: "a.ts" }, { path: "b.ts" }] }]);
    expect(problem).toBe("Skipped 2 chapters without a title or any ranges");
  });

  it("reports broken files", () => {
    expect(parseNotes("{").problem).toMatch(/isn't valid JSON/);
    expect(parseNotes('{"notes": []}').problem).toMatch(/"chapters" list/);
  });
});

describe("readNotes", () => {
  it("reads notes from the repo's git folder", async () => {
    const r = makeRepo();
    r.write("a.ts", "a\n");
    r.commit("init");
    expect(await readNotes(r.root)).toMatchObject({ notes: null });
    const path = await notesPath(r.root);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ chapters: [{ title: "Hi", ranges: ["a.ts"] }] }));
    expect(path).toBe(`${r.root}/.git/moire/notes.json`);
    expect((await readNotes(r.root)).notes?.chapters).toHaveLength(1);
  });

  const setup = async (files: string[]) => {
    const r = makeRepo();
    for (const name of files) r.write(name, "one\n");
    r.commit("init");
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
    expect(file.path).toBe(`${r.root}/.git/moire/commits/${r.git("rev-parse", "HEAD")}.json`);
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
    const { r, write, working } = await setup(["b.ts"]);
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    r.write("a.ts", lines.join("\n") + "\n");
    r.commit("a");
    lines[19] = "CHANGED";
    r.write("a.ts", lines.join("\n") + "\n");
    write({ chapters: [chapter("X", "a.ts", [20, 20], "CHANGED")] });
    expect(await working()).toEqual(["X"]);
    r.write("a.ts", ["new", "new", "new", "new", "new", ...lines].join("\n") + "\n");
    r.write("b.ts", "two\n");
    r.git("commit", "-qm", "b", "--", "b.ts");
    expect(await working()).toEqual(["X"]);
  });

  it("leaves chapters alone when HEAD moves past commits made elsewhere", async () => {
    const { r, write, working, committed } = await setup(["a.ts"]);
    const tree = r.git("write-tree");
    const theirs = r.git("commit-tree", tree, "-p", "HEAD", "-m", "upstream");
    r.git("update-ref", "refs/heads/up", theirs);
    r.write("a.ts", "two\n");
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

    const fresh = makeRepo();
    fresh.write("a.ts", "one\n");
    fresh.commit("init");
    const freshPath = await notesPath(fresh.root);
    mkdirSync(dirname(freshPath), { recursive: true });
    fresh.write("a.ts", "two\n");
    writeFileSync(freshPath, JSON.stringify({ chapters: [chapter("A", "a.ts")] }));
    fresh.git("commit", "-qam", "a");
    expect((await readNotes(fresh.root)).notes).toBeNull();
    expect((await readNotes(fresh.root, "HEAD")).notes?.chapters).toHaveLength(1);
  });

  it("carries chapters through an amend and brings them back on reset", async () => {
    const { r, write, working, committed } = await setup(["a.ts", "b.ts"]);
    r.write("a.ts", "two\n");
    write({ chapters: [chapter("A", "a.ts")] });
    expect(await working()).toEqual(["A"]);
    r.git("commit", "-qam", "a");
    expect(await working()).toEqual([]);
    r.git("commit", "-q", "--amend", "-m", "a, reworded");
    expect(await committed()).toEqual(["A"]);

    r.write("b.ts", "two\n");
    write({ chapters: [chapter("B", "b.ts")] });
    expect(await working()).toEqual(["B"]);
    r.git("commit", "-q", "--amend", "-am", "a and b");
    expect(await committed()).toEqual(["A", "B"]);

    r.git("reset", "-q", "--soft", "HEAD~1");
    expect(await working()).toEqual(["A", "B"]);
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

  it("places ranges in the work tree", async () => {
    const { r, write } = await setup(["a.ts"]);
    r.write("a.ts", "new\none\nadded\n");
    write({ chapters: [{ title: "A", ranges: [{ path: "a.ts", lines: [2, 2], code: "added" }, "a.ts", { path: "../x", lines: [1, 1] }] }] });
    expect((await readNotes(r.root)).placed).toEqual([[{ start: 3, end: 3 }, "all", { start: 1, end: 1 }]]);
  });
});
