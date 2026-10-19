import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, renameSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CompareMode, FileDiff } from "../shared/types";
import {
  blobSizes,
  branches,
  commitDetail,
  commits,
  diff,
  fileContents,
  gitInput,
  keepUntrackedCache,
  listDir,
  manyContents,
  missingGit,
  oldGit,
  readBlob,
  repoInfo,
  repoProblem,
  tree,
  UNTRACKED_READ_LIMIT,
  upstream,
  worktrees,
} from "./git";
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
    expect(await fileContents(r.root, { kind: "unstaged" }, file)).toEqual({ a: v1, b: v3, hidden: false });
    r.git("add", "a.txt");
    r.write("a.txt", v3);
    expect(await fileContents(r.root, { kind: "all" }, file)).toEqual({ a: v1, b: v3, hidden: false });
    expect(await fileContents(r.root, { kind: "staged" }, { path: "staged.txt", status: "added" })).toEqual({
      a: null,
      b: "staged\n",
      hidden: false,
    });
    expect(await fileContents(r.root, { kind: "unstaged" }, { path: "dir/new.txt", status: "untracked" })).toEqual({
      a: null,
      b: "fresh\nno newline",
      hidden: false,
    });
  });
});

describe("staged, then changed", () => {
  it("flags a file edited after it was staged whole, but not one staged in part", async () => {
    const r = makeRepo();
    r.write("a.txt", "one\n");
    r.write("b.txt", "one\n");
    r.commit("init");
    r.write("a.txt", "two\n");
    r.git("add", "a.txt");
    r.write("c.txt", "new\n");
    expect((await diff(r.root, { kind: "unstaged" })).progress).toEqual({ stagedFiles: 1, totalFiles: 2, lines: { staged: 2, total: 3 } });

    r.write("a.txt", "three\n");
    r.write("b.txt", "two\n");
    r.git("add", "b.txt");
    r.write("b.txt", "three\n");
    const res = await diff(r.root, { kind: "all" });
    expect(res.files.filter((f) => f.changedSinceStaged).map((f) => f.path)).toEqual(["a.txt"]);
    expect(res.progress).toEqual({ stagedFiles: 0, totalFiles: 3, lines: { staged: 4, total: 9 } });
    expect(byPath((await diff(r.root, { kind: "unstaged" })).files, "a.txt").changedSinceStaged).toBe(true);
  });

  it("counts a staged rename once", async () => {
    const r = makeRepo();
    r.write("a.txt", "one\ntwo\nthree\n");
    r.commit("init");
    r.git("mv", "a.txt", "b.txt");
    const res = await diff(r.root, { kind: "all" });
    expect(res.files.map((f) => f.path)).toEqual(["b.txt"]);
    expect(res.progress).toEqual({ stagedFiles: 1, totalFiles: 1, lines: { staged: 1, total: 1 } });
  });

  it("still loads when it can't write to .git", async () => {
    const r = makeRepo();
    r.write("a.txt", "one\n");
    r.commit("init");
    r.write("a.txt", "two\n");
    r.git("add", "a.txt");
    chmodSync(join(r.root, ".git"), 0o555);
    try {
      expect((await diff(r.root, { kind: "unstaged" })).progress).toMatchObject({ stagedFiles: 1, totalFiles: 1 });
    } finally {
      chmodSync(join(r.root, ".git"), 0o755);
    }
  });

  it("starts over when its record is empty or garbled", async () => {
    const r = makeRepo();
    r.write("a.txt", "one\n");
    r.commit("init");
    r.write("a.txt", "two\n");
    r.git("add", "a.txt");
    for (const junk of ["", '{"a.txt": "12']) {
      writeFileSync(join(r.root, ".git", "moire-staged"), junk);
      expect((await diff(r.root, { kind: "unstaged" })).progress).toMatchObject({ stagedFiles: 1, totalFiles: 1 });
    }
    expect(JSON.parse(readFileSync(join(r.root, ".git", "moire-staged"), "utf8"))).toHaveProperty("a.txt");
  });

  it("forgets a file once its staged version changes", async () => {
    const r = makeRepo();
    r.write("a.txt", "one\n");
    r.commit("init");
    r.write("a.txt", "two\n");
    r.git("add", "a.txt");
    await diff(r.root, { kind: "unstaged" });
    r.git("reset", "-q");
    r.write("a.txt", "three\n");
    r.git("add", "a.txt");
    r.write("a.txt", "four\n");
    expect(byPath((await diff(r.root, { kind: "unstaged" })).files, "a.txt").changedSinceStaged).toBeUndefined();
  });

  it("gives the unstaged view the index lines staged earlier, and where staged deletions were", async () => {
    const r = makeRepo();
    r.write("a.txt", lines(10));
    r.write("b.txt", lines(3));
    r.commit("init");
    r.write("a.txt", lines(10).replace("line 2\n", "two\n").replace("line 5\n", "line 5\nnew\n").replace("line 8\n", ""));
    r.git("add", "a.txt");
    r.write("a.txt", lines(10).replace("line 2\n", "two\n").replace("line 5\n", "line 5\nnew\n").replace("line 8\n", "").replace("line 10", "ten"));
    r.write("b.txt", lines(3).replace("line 1", "one"));
    r.git("add", "b.txt");
    r.git("mv", "b.txt", "c.txt");
    r.write("c.txt", lines(3).replace("line 1", "one").replace("line 3", "three"));

    const files = (await diff(r.root, { kind: "unstaged" })).files;
    expect(byPath(files, "a.txt").alreadyStaged).toEqual({ stagedRanges: [2, 6].map((n) => [n, n]), deletionsAfter: [8] });
    expect(byPath(files, "c.txt").alreadyStaged).toEqual({ stagedRanges: [[1, 1]], deletionsAfter: [] });
    expect(byPath((await diff(r.root, { kind: "unstaged" }, ["a.txt"])).files, "a.txt").alreadyStaged).toBeUndefined();
    expect(byPath((await diff(r.root, { kind: "all" })).files, "a.txt").alreadyStaged).toBeUndefined();
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
    expect(await fileContents(r.root, mode, { path: "gone.txt", status: "deleted" })).toEqual({ a: "bye\n", b: null, hidden: false });
    expect(await fileContents(r.root, { kind: "commit", sha: root }, { path: "eof.txt", status: "added" })).toEqual({
      a: null,
      b: "a\nb",
      hidden: false,
    });
  });

  it("reads many files at once the same way as one at a time", async () => {
    const files = (await diff(r.root, mode)).files;
    const one = await Promise.all(files.map((f) => fileContents(r.root, mode, f)));
    expect(await manyContents(r.root, mode, files)).toEqual(one);
    expect(one.map((c) => c.hidden)).toEqual([true, false, false, false]);
  });

  it("flags binary and oversized files as too large", async () => {
    expect(await fileContents(r.root, mode, { path: "bin.dat", status: "modified" })).toEqual({ a: null, b: null, hidden: true, binary: true });
    r.write("huge.txt", "x".repeat(2 * 1024 * 1024 + 10));
    const huge = await fileContents(r.root, { kind: "unstaged" }, { path: "huge.txt", status: "untracked" });
    expect(huge).toEqual({ a: null, b: null, hidden: true });
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
    expect((await branches(r.root)).branches).toEqual([]);
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
      hidden: false,
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
    expect(shared).toEqual({ a: "base\n", b: "base\nfeature\n", hidden: false });
  });

  it("lists branches with the current one first", async () => {
    r.git("checkout", "-q", "feature");
    expect((await branches(r.root)).branches).toEqual(["feature", "main"]);
    r.git("checkout", "-q", "main");
    expect(await branches(r.root)).toEqual({ current: "main", upstream: null, branches: ["main", "feature"], remotes: [], tags: [] });
  });

  it("reads a commit's message and author", async () => {
    r.git("commit", "-q", "--allow-empty", "-m", "subject line", "-m", "Body one.\nBody two.");
    expect(await commitDetail(r.root, "HEAD")).toMatchObject({ subject: "subject line", body: "Body one.\nBody two.", author: "Test" });
    r.git("reset", "-q", "--hard", "HEAD^");
  });

  it("reports repo info and rejects non-repositories", async () => {
    const info = await repoInfo(join(r.root, "."));
    expect(info).toMatchObject({ root: r.root, branch: "main" });
    expect(info.head).toMatch(/^[0-9a-f]{7,}$/);
    r.git("checkout", "-q", "--detach");
    expect((await repoInfo(r.root)).branch).toBeNull();
    r.git("checkout", "-q", "main");
    expect(info.state).toBeUndefined();
    writeFileSync(join(r.root, ".git", "MERGE_HEAD"), r.git("rev-parse", "feature") + "\n");
    expect((await repoInfo(r.root)).state).toBe("merging");
    unlinkSync(join(r.root, ".git", "MERGE_HEAD"));
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "moire-norepo-")));
    dirs.push(outside);
    await expect(repoInfo(outside)).rejects.toThrow(`${outside} isn't a git repository`);
    await expect(repoInfo(join(outside, "gone"))).rejects.toThrow(`${outside}/gone doesn't exist`);
  });
});

describe("input", () => {
  it("survives git exiting before it reads its input", async () => {
    const r = makeRepo();
    r.write("a.txt", "a\n");
    r.commit("init");
    await expect(gitInput(r.root, ["rev-parse", "HEAD"], Buffer.alloc(8 * 1024 * 1024))).resolves.toMatch(/^[0-9a-f]{40}\n$/);
  });
});

describe("repo problems", () => {
  const failed = (stderr: string) => Object.assign(new Error(`Command failed: git rev-parse\n${stderr}`), { stderr });
  const home = homedir();

  it("puts git's refusals in plain words", () => {
    expect(repoProblem(`${home}/x`, failed("fatal: not a git repository (or any of the parent directories): .git\n"))).toBe("~/x isn't a git repository");
    expect(repoProblem("/srv/x", failed("fatal: cannot change to '/srv/x': Permission denied\n"))).toBe("moire can't read /srv/x: permission denied");
    const dubious = [
      "fatal: detected dubious ownership in repository at '/srv/x'",
      "To add an exception for this directory, call:",
      "",
      "\tgit config --global --add safe.directory /srv/x",
    ].join("\n");
    expect(repoProblem("/srv/x", failed(dubious))).toBe(
      "/srv/x belongs to another user, so git won't open it. To trust it, run: git config --global --add safe.directory /srv/x",
    );
    expect(repoProblem("/srv/x", failed("fatal: something new\n"))).toBe("something new");
  });

  it("knows when git itself is missing", () => {
    const enoent = Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" });
    expect(missingGit(enoent, "linux")).toMatch(/^git isn't installed/);
    expect(missingGit(enoent, "darwin")).toContain("xcode-select --install");
    const stub = Object.assign(new Error("Command failed"), { code: 1, stderr: "xcode-select: note: No developer tools were found, requesting install." });
    expect(missingGit(stub, "darwin")).toContain("xcode-select --install");
    expect(missingGit(stub, "linux")).toBeNull();
  });

  it("names a git too old for moire", () => {
    expect(oldGit("git version 2.25.1\n")).toBe("moire needs git 2.26 or newer, and this is 2.25.1.");
    expect(oldGit("git version 2.26.0\n")).toBeNull();
    expect(oldGit("git version 2.50.1 (Apple Git-155)\n")).toBeNull();
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

describe("repeated refreshes", () => {
  const texts = (file: FileDiff) => file.hunks.flatMap((h) => h.lines.map((l) => l.text));

  it("rereads an untracked file once its size or mtime changes", async () => {
    const r = makeRepo();
    r.write("a.txt", "a\n");
    r.commit("init");
    r.write("new.txt", "one\n");
    expect(texts(byPath((await diff(r.root, { kind: "unstaged" })).files, "new.txt"))).toEqual(["one"]);
    r.write("new.txt", "one\ntwo\n");
    expect(texts(byPath((await diff(r.root, { kind: "unstaged" })).files, "new.txt"))).toEqual(["one", "two"]);
    const { mtime } = statSync(join(r.root, "new.txt"));
    r.write("new.txt", "ONE\nTWO\n");
    utimesSync(join(r.root, "new.txt"), mtime, new Date(mtime.getTime() + 5000));
    expect(texts(byPath((await diff(r.root, { kind: "all" })).files, "new.txt"))).toEqual(["ONE", "TWO"]);
    unlinkSync(join(r.root, "new.txt"));
    expect(paths((await diff(r.root, { kind: "unstaged" })).files)).toEqual([]);
  });

  it("drops the untracked cache of repos no window shows", async () => {
    const r = makeRepo();
    r.write("a.txt", "a\n");
    r.commit("init");
    r.write("new.txt", "one\n");
    const mtime = new Date(2020, 0, 1);
    utimesSync(join(r.root, "new.txt"), mtime, mtime);
    const reread = async () => {
      r.write("new.txt", "two\n");
      utimesSync(join(r.root, "new.txt"), mtime, mtime);
      return texts(byPath((await diff(r.root, { kind: "unstaged" })).files, "new.txt"));
    };
    await diff(r.root, { kind: "unstaged" });
    expect(await reread()).toEqual(["one"]);
    keepUntrackedCache([r.root]);
    expect(await reread()).toEqual(["one"]);
    keepUntrackedCache(["/somewhere/else"]);
    expect(await reread()).toEqual(["two"]);
  });

  it("keeps versions stable until a file changes", async () => {
    const r = makeRepo();
    r.write("a.txt", "a\n");
    r.write("b.txt", "b\n");
    r.commit("init");
    r.write("a.txt", "A\n");
    r.write("b.txt", "B\n");
    r.write("new.txt", "new\n");
    const first = await diff(r.root, { kind: "all" });
    const second = await diff(r.root, { kind: "all" });
    expect(second.version).toBe(first.version);
    expect(second.files.map((f) => f.version)).toEqual(first.files.map((f) => f.version));
    expect(new Set(first.files.map((f) => f.version)).size).toBe(3);

    r.write("a.txt", "AA\n");
    r.write("new.txt", "newer\n");
    const third = await diff(r.root, { kind: "all" });
    expect(third.version).not.toBe(first.version);
    const changed = third.files.filter((f, i) => f.version !== first.files[i].version).map((f) => f.path);
    expect(changed).toEqual(["a.txt", "new.txt"]);

    r.git("add", "b.txt");
    expect(byPath((await diff(r.root, { kind: "all" })).files, "b.txt").version).not.toBe(byPath(third.files, "b.txt").version);
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

  it("marks lockfiles and linguist-generated files, but not snapshots", async () => {
    const files = (await diff(r.root, { kind: "unstaged" })).files;
    expect(files.map((f) => `${f.path}:${f.noise ?? "-"}`)).toEqual([
      "gen/api.ts:Generated file",
      "pnpm-lock.yaml:Lockfile",
      "src/__snapshots__/x.test.ts.snap:-",
      "src/a.ts:-",
    ]);
  });

  it("folds minified files and source maps, but not code with the odd long line", async () => {
    const long = "x".repeat(30_000);
    r.write("dist/app.js", `${long}\n`);
    r.write("dist/app.min.css", "a{b:c}\n");
    r.write("dist/app.js.map", "{}\n");
    r.write("src/data.ts", `${lines(40)}const blob = "${long}";\n`);
    const files = (await diff(r.root, { kind: "unstaged" }, ["dist", "src/data.ts"])).files;
    expect(files.map((f) => `${f.path}:${f.noise ?? "-"}`)).toEqual([
      "dist/app.js:Minified file",
      "dist/app.js.map:Source map",
      "dist/app.min.css:Minified file",
      "src/data.ts:-",
    ]);
  });
});

describe("size limit", () => {
  it("marks a tracked file too large once its changes pass 2 MB, but shows a small edit to a big file", async () => {
    const r = makeRepo();
    const big = lines(200_000);
    r.write("big.txt", big);
    r.write("grows.txt", "a\n");
    r.commit("init");
    r.write("big.txt", big.replace("line 5\n", "line five\n"));
    r.write("grows.txt", big);
    const files = (await diff(r.root, { kind: "unstaged" })).files;
    expect(byPath(files, "grows.txt")).toMatchObject({ tooLarge: true, hunks: [], additions: 200_000 });
    expect(byPath(files, "big.txt").tooLarge).toBeUndefined();
    expect(byPath(files, "big.txt").hunks).toHaveLength(1);
  });
});

describe("file modes", () => {
  it("reports executable bits and symlinks, tracked and untracked", async () => {
    const r = makeRepo();
    r.write("run.sh", "echo\n");
    r.write("plain.txt", "a\n");
    symlinkSync("plain.txt", join(r.root, "link"));
    r.commit("init");
    chmodSync(join(r.root, "run.sh"), 0o755);
    unlinkSync(join(r.root, "link"));
    symlinkSync("run.sh", join(r.root, "link"));
    r.write("new.sh", "echo\n");
    chmodSync(join(r.root, "new.sh"), 0o755);
    symlinkSync("new.sh", join(r.root, "new-link"));
    r.write("plain.txt", "b\n");
    const files = (await diff(r.root, { kind: "unstaged" })).files;
    const mode = (p: string) => [byPath(files, p).oldMode, byPath(files, p).newMode];
    expect(mode("run.sh")).toEqual(["100644", "100755"]);
    expect(byPath(files, "run.sh").hunks).toEqual([]);
    expect(mode("link")).toEqual(["120000", "120000"]);
    expect(mode("new.sh")).toEqual([undefined, "100755"]);
    expect(mode("new-link")).toEqual([undefined, "120000"]);
    expect(byPath(files, "new-link").hunks[0].lines[0].text).toBe("new.sh");
    expect(mode("plain.txt")).toEqual([undefined, undefined]);
  });
});

describe("renames git doesn't know about yet", () => {
  const setup = () => {
    const r = makeRepo();
    r.write("old.ts", lines(20));
    r.write("gone.ts", lines(20, "gone"));
    r.commit("init");
    renameSync(join(r.root, "old.ts"), join(r.root, "new.ts"));
    r.write("new.ts", lines(20).replace("line 3\n", "line three\n"));
    unlinkSync(join(r.root, "gone.ts"));
    r.write("other.ts", "unrelated\n");
    return r;
  };

  it("pairs a deleted file with a similar untracked one, in the unstaged and all views", async () => {
    const r = setup();
    const index = readFileSync(join(r.root, ".git", "index"));
    for (const kind of ["unstaged", "all"] as const) {
      const files = (await diff(r.root, { kind })).files;
      expect(paths(files)).toEqual(["deleted:gone.ts", "renamed:new.ts", "untracked:other.ts"]);
      const f = byPath(files, "new.ts");
      expect(f).toMatchObject({ oldPath: "old.ts", additions: 1, deletions: 1 });
      expect(f.hunks[0].lines.filter((l) => l.kind !== "ctx")).toEqual([
        { kind: "del", text: "line 3", oldNo: 3 },
        { kind: "add", text: "line three", newNo: 3 },
      ]);
      expect(await fileContents(r.root, { kind }, f)).toMatchObject({ a: lines(20), b: lines(20).replace("line 3\n", "line three\n") });
    }
    expect(readFileSync(join(r.root, ".git", "index")).equals(index)).toBe(true);
    expect(r.git("diff", "--cached", "--name-only")).toBe("");
    expect(r.git("ls-files")).toBe("gone.ts\nold.ts");
  });

  it("pairs them when only those two paths are asked for", async () => {
    const r = setup();
    expect(paths((await diff(r.root, { kind: "unstaged" }, ["new.ts", "old.ts"])).files)).toEqual(["renamed:new.ts"]);
  });

  it("pairs a plain move with no edits as a rename with no hunks", async () => {
    const r = makeRepo();
    r.write("src/old.ts", lines(20));
    r.commit("init");
    renameSync(join(r.root, "src/old.ts"), join(r.root, "src/new.ts"));
    for (const kind of ["unstaged", "all"] as const) {
      const files = (await diff(r.root, { kind })).files;
      expect(paths(files)).toEqual(["renamed:src/new.ts"]);
      expect(files[0]).toMatchObject({ oldPath: "src/old.ts", additions: 0, deletions: 0, hunks: [] });
    }
  });
});

describe("renames made with git mv", () => {
  const setup = (edit: boolean) => {
    const r = makeRepo();
    r.write("old.ts", lines(20));
    r.commit("init");
    r.git("mv", "old.ts", "new.ts");
    if (edit) r.write("new.ts", lines(20).replace("line 3\n", "line three\n"));
    return r;
  };

  it("shows a pure rename with no hunks in staged and all, and nothing unstaged", async () => {
    const r = setup(false);
    expect((await diff(r.root, { kind: "unstaged" })).files).toEqual([]);
    for (const kind of ["staged", "all"] as const) {
      const files = (await diff(r.root, { kind })).files;
      expect(paths(files)).toEqual(["renamed:new.ts"]);
      expect(files[0]).toMatchObject({ oldPath: "old.ts", additions: 0, deletions: 0, hunks: [] });
    }
  });

  it("shows the rename staged, the edit unstaged and both in all", async () => {
    const r = setup(true);
    const [unstaged, staged, all] = await Promise.all((["unstaged", "staged", "all"] as const).map((kind) => diff(r.root, { kind })));
    expect(paths(unstaged.files)).toEqual(["modified:new.ts"]);
    expect(paths(staged.files)).toEqual(["renamed:new.ts"]);
    expect(staged.files[0].hunks).toEqual([]);
    expect(paths(all.files)).toEqual(["renamed:new.ts"]);
    expect(all.files[0]).toMatchObject({ oldPath: "old.ts", additions: 1, deletions: 1 });
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

describe("Git LFS", () => {
  it("reads an image from the LFS store, and says when only its pointer is here", async () => {
    const r = makeRepo();
    const pointer = (data: Buffer) =>
      `version https://git-lfs.github.com/spec/v1\noid sha256:${createHash("sha256").update(data).digest("hex")}\nsize ${data.length}\n`;
    const [missing, stored] = [Buffer.from([1, 0, 1]), Buffer.from([2, 0, 2, 0])];
    r.write("logo.png", pointer(missing));
    r.commit("init");
    r.write("logo.png", pointer(stored));
    const sha = r.commit("stored");
    const oid = createHash("sha256").update(stored).digest("hex");
    r.write(`.git/lfs/objects/${oid.slice(0, 2)}/${oid.slice(2, 4)}/${oid}`, stored);

    const side = { kind: "commit" as const, rev: sha, label: "" };
    expect(await readBlob(r.root, side, "logo.png", 1024)).toEqual(stored);
    expect(await readBlob(r.root, { ...side, rev: r.git("rev-parse", "HEAD^") }, "logo.png", 1024)).toEqual(Buffer.from(pointer(missing)));
    expect(await blobSizes(r.root, { kind: "commit", sha }, { path: "logo.png", status: "modified" })).toEqual([{ bytes: 3, lfsMissing: true }, { bytes: 4 }]);
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
    expect(await fileContents(r.root, { kind: "unstaged" }, { path: "IDEAS.md", status: "unchanged" })).toEqual({ a: null, b: "# ideas\n", hidden: false });
    expect(await fileContents(r.root, { kind: "commit", sha: first }, { path: "src/a.ts", status: "unchanged" })).toEqual({
      a: null,
      b: "a\n",
      hidden: false,
    });
  });

  it("lists an ignored folder's entries, and nothing outside the repo", async () => {
    expect(await listDir(r.root, "out/")).toEqual(["out/deep/"]);
    expect(await listDir(r.root, "out/deep/")).toEqual(["out/deep/x.js"]);
    expect(await listDir(r.root, "../")).toEqual([]);
    expect(await listDir(r.root, "/etc/")).toEqual([]);
  });
});

describe("index lock", () => {
  it("never rewrites the index, and leaves out files whose stat info alone is stale", async () => {
    const r = makeRepo();
    r.write("a.txt", "a\n");
    r.write("touched.txt", "same\n");
    r.write("staged.txt", "s\n");
    r.commit("init");
    r.write("a.txt", "b\n");
    r.write("staged.txt", "S\n");
    r.git("add", "staged.txt");
    const later = new Date(Date.now() + 5000);
    utimesSync(join(r.root, "touched.txt"), later, later);
    const index = join(r.root, ".git", "index");
    const before = readFileSync(index);
    for (const kind of ["unstaged", "staged", "all"] as const) {
      const res = await diff(r.root, { kind });
      expect(paths(res.files)).toEqual(
        kind === "unstaged" ? ["modified:a.txt"] : kind === "staged" ? ["modified:staged.txt"] : ["modified:a.txt", "modified:staged.txt"],
      );
      if (kind === "all") expect(res.progress).toMatchObject({ stagedFiles: 1, totalFiles: 2 });
    }
    expect(readFileSync(index).equals(before)).toBe(true);
  });

  it("follows the repo's diff.algorithm, as git diff does", async () => {
    const r = makeRepo();
    r.write("f", "c\n{\n{\nc\n{\nb\n{\na\n");
    r.commit("init");
    r.write("f", "c\n{\n{\nc\nb\n{\nb\nx\n{\na\nb\n");
    r.git("config", "diff.algorithm", "histogram");
    const changed = async () => (await diff(r.root, { kind: "unstaged" })).files[0].hunks[0].lines.filter((l) => l.kind !== "ctx").map((l) => l.kind + l.text);
    expect(await changed()).toEqual(["del{", "addb", "addx", "add{", "addb"]);
  });
});

describe("upstream tracking", () => {
  const remote = makeRepo();
  remote.write("a.txt", "a\n");
  remote.commit("init");
  const r = makeRepo();
  r.git("remote", "add", "origin", remote.root);
  r.git("fetch", "-q", "origin");
  r.git("reset", "-q", "--hard", "origin/main");
  r.git("tag", "v1");

  it("has no counts without an upstream", async () => {
    expect(await upstream(r.root)).toBeNull();
  });

  it("counts commits ahead of and behind the upstream as of the last fetch", async () => {
    r.git("branch", "-q", "--set-upstream-to=origin/main");
    r.write("b.txt", "b\n");
    r.commit("local one");
    r.write("c.txt", "c\n");
    r.commit("local two");
    remote.write("d.txt", "d\n");
    remote.commit("remote one");
    expect(await upstream(r.root)).toMatchObject({ name: "origin/main", ahead: 2, behind: 0, fetchedAt: expect.any(Number) });
    r.git("fetch", "-q", "origin");
    const up = (await upstream(r.root))!;
    expect(up).toMatchObject({ ahead: 2, behind: 1 });
    expect(Math.abs(up.fetchedAt! - Date.now())).toBeLessThan(60_000);
  });

  it("lists remote branches and tags as refs", async () => {
    expect(await branches(r.root)).toEqual({ current: "main", upstream: "origin/main", branches: ["main"], remotes: ["origin/main"], tags: ["v1"] });
  });
});

describe("worktrees", () => {
  it("is empty for a repo with one worktree", async () => {
    const r = makeRepo();
    r.write("a.txt", "a\n");
    r.commit("init");
    expect(await worktrees(r.root)).toEqual([]);
  });

  it("lists every worktree with its branch and change count", async () => {
    const r = makeRepo();
    r.write("a.txt", "a\n");
    r.commit("init");
    const other = realpathSync(mkdtempSync(join(tmpdir(), "moire-wt-")));
    dirs.push(other);
    r.git("worktree", "add", "-q", "-b", "agent", join(other, "agent"));
    writeFileSync(join(other, "agent", "a.txt"), "changed\n");
    writeFileSync(join(other, "agent", "new.txt"), "new\n");
    expect(await worktrees(r.root)).toEqual([
      { path: r.root, branch: "main", changes: 0 },
      { path: join(other, "agent"), branch: "agent", changes: 2 },
    ]);
  });
});

it("shows a moved submodule in a commit even when git config asks for submodule logs", async () => {
  const sub = makeRepo();
  sub.write("x.txt", "x\n");
  sub.commit("one");
  const r = makeRepo();
  r.git("-c", "protocol.file.allow=always", "submodule", "add", "-q", sub.root, "sub");
  r.commit("add sub");
  r.git("config", "diff.submodule", "log");
  r.git("-C", "sub", "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "--allow-empty", "-m", "two");
  const sha = r.commit("move sub");
  const res = await diff(r.root, { kind: "commit", sha });
  expect(res.files.map((f) => f.path)).toEqual(["sub"]);
});
