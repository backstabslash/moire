import { mkdtempSync, realpathSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CompareMode, FileDiff } from "../shared/types";
import { branches, commits, diff, fileContents, listDir, manyContents, repoInfo, tree, UNTRACKED_READ_LIMIT } from "./git";
import { dirs, makeRepo } from "./test-repo";

const paths = (files: FileDiff[]) => files.map((f) => `${f.status}:${f.path}`);
const byPath = (files: FileDiff[], path: string) => files.find((f) => f.path === path)!;
const lines = (n: number, tag = "line") => Array.from({ length: n }, (_, i) => `${tag} ${i + 1}\n`).join("");

describe("working tree modes", () => {
  const r = makeRepo();
  r.write("a.txt", "one\ntwo\nthree\n");
  r.write("keep.txt", "keep\n");
  const head = r.commit("init").slice(0, 7);
  r.write("a.txt", "one\nTWO\nthree\n");
  r.write("staged.txt", "staged\n");
  r.git("add", "staged.txt");
  r.write("a.txt", "one\nTWO\nthree\nfour\n");
  r.write("dir/new.txt", "fresh\nno newline");

  it("unstaged compares index to worktree and includes untracked files", async () => {
    const res = await diff(r.root, { kind: "unstaged" });
    expect(res.a).toEqual({ kind: "index", label: "Index" });
    expect(res.b).toEqual({ kind: "worktree", label: "Working tree" });
    expect(paths(res.files)).toEqual(["modified:a.txt", "untracked:dir/new.txt"]);
    const u = byPath(res.files, "dir/new.txt");
    expect(u.additions).toBe(2);
    expect(u.hunks[0]).toMatchObject({ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2 });
    expect(u.hunks[0].lines).toEqual([
      { kind: "add", text: "fresh", newNo: 1 },
      { kind: "add", text: "no newline", newNo: 2, noNewline: true },
    ]);
  });

  it("staged compares HEAD to index and excludes untracked files", async () => {
    const res = await diff(r.root, { kind: "staged" });
    expect(res.a).toMatchObject({ kind: "commit", label: `HEAD ${head}` });
    expect(res.b.kind).toBe("index");
    expect(paths(res.files)).toEqual(["added:staged.txt"]);
  });

  it("all compares HEAD to worktree and includes untracked files", async () => {
    const res = await diff(r.root, { kind: "all" });
    expect(res.a.kind).toBe("commit");
    expect(res.b.kind).toBe("worktree");
    expect(paths(res.files)).toEqual(["modified:a.txt", "untracked:dir/new.txt", "added:staged.txt"]);
    const a = byPath(res.files, "a.txt");
    expect([a.additions, a.deletions]).toEqual([2, 1]);
  });

  it("reads file contents for each side", async () => {
    const file = { path: "a.txt", status: "modified" as const };
    const v1 = "one\ntwo\nthree\n";
    const v3 = "one\nTWO\nthree\nfour\n";
    expect(await fileContents(r.root, { kind: "unstaged" }, file)).toEqual({ a: v1, b: v3, tooLarge: false });
    r.git("add", "a.txt");
    r.write("a.txt", v3);
    expect(await fileContents(r.root, { kind: "all" }, file)).toEqual({ a: v1, b: v3, tooLarge: false });
    expect(await fileContents(r.root, { kind: "staged" }, { path: "staged.txt", status: "added" })).toEqual({
      a: null,
      b: "staged\n",
      tooLarge: false,
    });
    expect(await fileContents(r.root, { kind: "unstaged" }, { path: "dir/new.txt", status: "untracked" })).toEqual({
      a: null,
      b: "fresh\nno newline",
      tooLarge: false,
    });
  });
});

describe("commit mode", () => {
  const r = makeRepo();
  const body = lines(20);
  r.write("old.txt", body);
  r.write("gone.txt", "bye\n");
  r.write("eof.txt", "a\nb");
  r.write("bin.dat", Buffer.from([0, 1, 2, 3, 0, 255]));
  const root = r.commit("root");
  r.git("mv", "old.txt", "new.txt");
  r.write("new.txt", body.replace("line 10\n", "line ten\n"));
  r.git("rm", "-q", "gone.txt");
  r.write("eof.txt", "a\nc");
  r.write("bin.dat", Buffer.from([0, 9, 9, 9, 0, 255]));
  const second = r.commit("second");
  const mode: CompareMode = { kind: "commit", sha: second };

  it("diffs a root commit against the empty tree", async () => {
    const res = await diff(r.root, { kind: "commit", sha: root });
    expect(res.a).toEqual({ kind: "empty", label: "Empty" });
    expect(res.b).toEqual({ kind: "commit", rev: root, label: root.slice(0, 7) });
    expect(paths(res.files)).toEqual(["added:bin.dat", "added:eof.txt", "added:gone.txt", "added:old.txt"]);
    expect(byPath(res.files, "old.txt").additions).toBe(20);
  });

  it("detects renames, deletions, binaries and missing EOF newlines", async () => {
    const res = await diff(r.root, mode);
    expect(res.a).toEqual({ kind: "commit", rev: root, label: `${second.slice(0, 7)}^` });
    expect(paths(res.files)).toEqual(["modified:bin.dat", "modified:eof.txt", "deleted:gone.txt", "renamed:new.txt"]);
    expect(byPath(res.files, "new.txt")).toMatchObject({ oldPath: "old.txt", additions: 1, deletions: 1 });
    expect(byPath(res.files, "bin.dat")).toMatchObject({ binary: true, hunks: [] });
    expect(byPath(res.files, "gone.txt")).toMatchObject({ deletions: 1, additions: 0 });
    const eof = byPath(res.files, "eof.txt").hunks[0].lines;
    expect(eof).toEqual([
      { kind: "ctx", text: "a", oldNo: 1, newNo: 1 },
      { kind: "del", text: "b", oldNo: 2, noNewline: true },
      { kind: "add", text: "c", newNo: 2, noNewline: true },
    ]);
  });

  it("reads both sides of renamed and deleted files", async () => {
    const renamed = await fileContents(r.root, mode, { path: "new.txt", oldPath: "old.txt", status: "renamed" });
    expect(renamed.a).toBe(body);
    expect(renamed.b).toContain("line ten\n");
    expect(await fileContents(r.root, mode, { path: "gone.txt", status: "deleted" })).toEqual({ a: "bye\n", b: null, tooLarge: false });
    expect(await fileContents(r.root, { kind: "commit", sha: root }, { path: "eof.txt", status: "added" })).toEqual({
      a: null,
      b: "a\nb",
      tooLarge: false,
    });
  });

  it("reads many files at once the same way as one at a time", async () => {
    const files = (await diff(r.root, mode)).files;
    const one = await Promise.all(files.map((f) => fileContents(r.root, mode, f)));
    expect(await manyContents(r.root, mode, files)).toEqual(one);
    expect(one.map((c) => c.tooLarge)).toEqual([true, false, false, false]);
  });

  it("flags binary and oversized files as too large", async () => {
    expect(await fileContents(r.root, mode, { path: "bin.dat", status: "modified" })).toEqual({ a: null, b: null, tooLarge: true });
    r.write("huge.txt", "x".repeat(2 * 1024 * 1024 + 10));
    const huge = await fileContents(r.root, { kind: "unstaged" }, { path: "huge.txt", status: "untracked" });
    expect(huge).toEqual({ a: null, b: null, tooLarge: true });
    const res = await diff(r.root, { kind: "unstaged" });
    expect(byPath(res.files, "huge.txt")).toMatchObject({ status: "untracked", binary: false, hunks: [] });
    unlinkSync(join(r.root, "huge.txt"));
  });

  it("lists commits newest first", async () => {
    const list = await commits(r.root, 10);
    expect(list.map((c) => c.subject)).toEqual(["second", "root"]);
    expect(list[0]).toMatchObject({ sha: second, short: second.slice(0, 7), author: "Test" });
    expect(new Date(list[0].date).toString()).not.toBe("Invalid Date");
    expect(await commits(r.root, 1)).toHaveLength(1);
  });

  it("throws on an unknown revision", async () => {
    await expect(diff(r.root, { kind: "commit", sha: "nope" })).rejects.toThrow("Unknown revision: nope");
  });
});

describe("unborn HEAD", () => {
  const r = makeRepo();
  r.write("first.txt", "hello\n");
  r.write("blob.bin", Buffer.from([1, 0, 2]));

  it("reports repo info without a head", async () => {
    expect(await repoInfo(join(r.root))).toEqual({ root: r.root, name: r.root.split("/").pop(), branch: "main", head: null });
    expect(await commits(r.root, 10)).toEqual([]);
    expect(await branches(r.root)).toEqual([]);
  });

  it("shows untracked files in unstaged and all modes", async () => {
    const res = await diff(r.root, { kind: "unstaged" });
    expect(paths(res.files)).toEqual(["untracked:blob.bin", "untracked:first.txt"]);
    expect(byPath(res.files, "blob.bin")).toMatchObject({ binary: true, hunks: [], additions: 0, blobs: expect.any(String) });
    expect(byPath(res.files, "first.txt").hunks[0].lines).toEqual([{ kind: "add", text: "hello", newNo: 1 }]);
    const all = await diff(r.root, { kind: "all" });
    expect(all.a.kind).toBe("empty");
    expect(paths(all.files)).toEqual(["untracked:blob.bin", "untracked:first.txt"]);
  });

  it("diffs staged files against an empty side", async () => {
    expect((await diff(r.root, { kind: "staged" })).files).toEqual([]);
    r.git("add", "first.txt");
    const res = await diff(r.root, { kind: "staged" });
    expect(res.a).toEqual({ kind: "empty", label: "Empty" });
    expect(paths(res.files)).toEqual(["added:first.txt"]);
    expect(await fileContents(r.root, { kind: "staged" }, { path: "first.txt", status: "added" })).toEqual({
      a: null,
      b: "hello\n",
      tooLarge: false,
    });
    const all = await diff(r.root, { kind: "all" });
    expect(paths(all.files)).toEqual(["untracked:blob.bin", "added:first.txt"]);
  });
});

describe("branches mode", () => {
  const r = makeRepo();
  r.write("shared.txt", "base\n");
  const fork = r.commit("base");
  r.git("checkout", "-q", "-b", "feature");
  r.write("feature.txt", "feature\n");
  r.write("shared.txt", "base\nfeature\n");
  const tip = r.commit("feature work");
  r.git("checkout", "-q", "main");
  r.write("main-only.txt", "later on main\n");
  r.write("shared.txt", "main changed\nbase\n");
  r.commit("main work");

  it("diffs head against the merge base, ignoring later base changes", async () => {
    const res = await diff(r.root, { kind: "branches", base: "main", head: "feature" });
    expect(res.a).toEqual({ kind: "commit", rev: fork, label: `main (merge base ${fork.slice(0, 7)})` });
    expect(res.b).toEqual({ kind: "commit", rev: tip, label: "feature" });
    expect(paths(res.files)).toEqual(["added:feature.txt", "modified:shared.txt"]);
    const shared = await fileContents(r.root, { kind: "branches", base: "main", head: "feature" }, { path: "shared.txt", status: "modified" });
    expect(shared).toEqual({ a: "base\n", b: "base\nfeature\n", tooLarge: false });
  });

  it("lists branches with the current one first", async () => {
    r.git("checkout", "-q", "feature");
    expect(await branches(r.root)).toEqual(["feature", "main"]);
    r.git("checkout", "-q", "main");
    expect(await branches(r.root)).toEqual(["main", "feature"]);
  });

  it("reports repo info and rejects non-repositories", async () => {
    const info = await repoInfo(join(r.root, "."));
    expect(info).toMatchObject({ root: r.root, branch: "main" });
    expect(info.head).toMatch(/^[0-9a-f]{7,}$/);
    r.git("checkout", "-q", "--detach");
    expect((await repoInfo(r.root)).branch).toBeNull();
    r.git("checkout", "-q", "main");
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "moire-norepo-")));
    dirs.push(outside);
    await expect(repoInfo(outside)).rejects.toThrow(`Not a git repository: ${outside}`);
  });
});

describe("many contents in working tree modes", () => {
  const r = makeRepo();
  r.write("a.txt", "one\n");
  r.write("b.txt", "two\n");
  r.commit("init");
  r.write("a.txt", "ONE\n");
  r.git("add", "a.txt");
  r.write("a.txt", "ONE!\n");
  r.write("new.txt", "fresh\n");

  it("matches single reads for unstaged, staged and all", async () => {
    for (const kind of ["unstaged", "staged", "all"] as const) {
      const files = (await diff(r.root, { kind })).files;
      const one = await Promise.all(files.map((f) => fileContents(r.root, { kind }, f)));
      expect(await manyContents(r.root, { kind }, files)).toEqual(one);
    }
  });
});

describe("conflicts and limits", () => {
  it("lists a conflicted file in the unstaged and staged views", async () => {
    const r = makeRepo();
    r.write("z.txt", "a\nb\n");
    r.write("other.txt", "x\n");
    r.commit("init");
    r.git("checkout", "-q", "-b", "f");
    r.write("z.txt", "a\nF\n");
    r.commit("f");
    r.git("checkout", "-q", "main");
    r.write("z.txt", "a\nM\n");
    r.commit("m");
    try {
      r.git("merge", "-q", "f");
    } catch {}
    r.write("other.txt", "y\n");
    expect(paths((await diff(r.root, { kind: "unstaged" })).files).sort()).toEqual(["conflicted:z.txt", "modified:other.txt"]);
    expect(paths((await diff(r.root, { kind: "staged" })).files)).toEqual(["conflicted:z.txt"]);
  });

  it("reads the files after a missing one whose path has spaces", async () => {
    const r = makeRepo();
    r.write("a b c.txt", "spaced\n");
    r.write("b.txt", "two\n");
    r.commit("init");
    const gone = { path: "no such file.txt", status: "modified" as const };
    const [missing, b] = await manyContents(r.root, { kind: "commit", sha: "HEAD" }, [gone, { path: "b.txt", status: "modified" }]);
    expect(missing.b).toBeNull();
    expect(b.b).toBe("two\n");
  });

  it("lists untracked files past the read limit without reading them", async () => {
    const r = makeRepo();
    r.write("a.txt", "a\n");
    r.commit("init");
    for (let i = 0; i <= UNTRACKED_READ_LIMIT; i++) r.write(`node_modules/m${String(i).padStart(5, "0")}.js`, "x\n");
    const files = (await diff(r.root, { kind: "unstaged" })).files;
    expect(files).toHaveLength(UNTRACKED_READ_LIMIT + 1);
    expect(files.at(-1)).toMatchObject({ unread: true, tooLarge: true, hunks: [] });
    expect(files[0].hunks).toHaveLength(1);
  });
});

describe("noise", () => {
  const r = makeRepo();
  r.write(".gitattributes", "gen/** linguist-generated\nkeep.lock linguist-generated=false\n");
  r.write("pnpm-lock.yaml", "a\n");
  r.write("gen/api.ts", "a\n");
  r.write("src/__snapshots__/x.test.ts.snap", "a\n");
  r.write("src/a.ts", "a\n");
  r.commit("init");
  for (const p of ["pnpm-lock.yaml", "gen/api.ts", "src/__snapshots__/x.test.ts.snap", "src/a.ts"]) r.write(p, "b\n");

  it("marks lockfiles, snapshots and linguist-generated files", async () => {
    const files = (await diff(r.root, { kind: "unstaged" })).files;
    expect(files.map((f) => `${f.path}:${f.noise ?? "-"}`)).toEqual([
      "gen/api.ts:Generated file",
      "pnpm-lock.yaml:Lockfile",
      "src/__snapshots__/x.test.ts.snap:Snapshot",
      "src/a.ts:-",
    ]);
  });
});

describe("binary rewrites", () => {
  it("change the file's blob ids, so a second rewrite isn't mistaken for the first", async () => {
    const r = makeRepo();
    r.write("logo.png", Buffer.from([1, 0, 1]));
    r.commit("init");
    r.write("logo.png", Buffer.from([2, 0, 2]));
    const first = byPath((await diff(r.root, { kind: "unstaged" })).files, "logo.png");
    r.write("logo.png", Buffer.from([3, 0, 3]));
    const second = byPath((await diff(r.root, { kind: "unstaged" })).files, "logo.png");
    expect(first.binary).toBe(true);
    expect(first.blobs).toMatch(/^[0-9a-f]+\.\.[0-9a-f]+$/);
    expect(second.blobs).not.toBe(first.blobs);
  });
});

describe("file tree", () => {
  const r = makeRepo();
  r.write(".gitignore", "IDEAS.md\nout/\n");
  r.write("src/a.ts", "a\n");
  r.write("gone.txt", "bye\n");
  const first = r.commit("init");
  r.write("src/b.ts", "b\n");
  r.git("add", "src/b.ts");
  r.write("new.txt", "new\n");
  r.write("IDEAS.md", "# ideas\n");
  r.write("out/deep/x.js", "x\n");
  unlinkSync(join(r.root, "gone.txt"));

  it("lists the working tree with ignored files, and an ignored folder as one entry", async () => {
    const t = await tree(r.root, { kind: "unstaged" });
    expect(t.files.sort()).toEqual([".gitignore", "gone.txt", "new.txt", "src/a.ts", "src/b.ts"]);
    expect(t.ignored.sort()).toEqual(["IDEAS.md", "out/"]);
  });

  it("lists the index in the staged view and the commit in the commit view", async () => {
    expect((await tree(r.root, { kind: "staged" })).files.sort()).toEqual([".gitignore", "gone.txt", "src/a.ts", "src/b.ts"]);
    expect(await tree(r.root, { kind: "commit", sha: first })).toEqual({ files: [".gitignore", "gone.txt", "src/a.ts"], ignored: [] });
  });

  it("reads an unchanged file from side B only", async () => {
    expect(await fileContents(r.root, { kind: "unstaged" }, { path: "IDEAS.md", status: "unchanged" })).toEqual({ a: null, b: "# ideas\n", tooLarge: false });
    expect(await fileContents(r.root, { kind: "commit", sha: first }, { path: "src/a.ts", status: "unchanged" })).toEqual({
      a: null,
      b: "a\n",
      tooLarge: false,
    });
  });

  it("lists an ignored folder's entries, and nothing outside the repo", async () => {
    expect(await listDir(r.root, "out/")).toEqual(["out/deep/"]);
    expect(await listDir(r.root, "out/deep/")).toEqual(["out/deep/x.js"]);
    expect(await listDir(r.root, "../")).toEqual([]);
    expect(await listDir(r.root, "/etc/")).toEqual([]);
  });
});
