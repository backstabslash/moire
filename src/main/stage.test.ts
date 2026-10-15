import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FileDiff, LineRef, StageRequest } from "../shared/types";
import { diff, UNTRACKED_READ_LIMIT } from "./git";
import { act, commit, undo } from "./stage";
import { makeRepo } from "./test-repo";

type Repo = ReturnType<typeof makeRepo>;

function setup() {
  const r = makeRepo();
  const log = join(r.root, ".git", "moire-undo.json");
  const file = async (mode: "unstaged" | "staged" | "all", path: string) => (await diff(r.root, { kind: mode })).files.find((f) => f.path === path);
  const run = (mode: StageRequest["mode"], action: StageRequest["action"], f: FileDiff, lines: LineRef[] | null = null) =>
    act(r.root, { mode, action, file: f, lines }, log);
  return { ...r, log, file, run };
}

const hunkLines = (f: FileDiff, h: number): LineRef[] => f.hunks[h].lines.flatMap((l, i) => (l.kind === "ctx" ? [] : [{ hunk: h, line: i }]));
const allLines = (f: FileDiff) => f.hunks.flatMap((_, h) => hunkLines(f, h));
const indexBlob = (r: Repo, path: string) => r.git("rev-parse", `:${path}`);
const worktreeBlob = (r: Repo, path: string) => r.git("hash-object", "--", path);
const body = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}\n`).join("");

function random(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed / 2 ** 31;
  };
}

function mutate(text: string, rand: () => number): string {
  const out: string[] = [];
  text.split("\n").forEach((line, i) => {
    const p = rand();
    if (p < 0.08) return;
    out.push(p < 0.16 ? `${line} changed` : line);
    if (rand() < 0.08) out.push(`inserted ${i}`);
  });
  const joined = out.join("\n");
  return rand() < 0.3 ? joined.replace(/\n$/, "") : joined.endsWith("\n") ? joined : `${joined}\n`;
}

describe("staging piece by piece", () => {
  for (let seed = 1; seed <= 12; seed++) {
    it(`matches git add, hunk by hunk and line by line (seed ${seed})`, async () => {
      const r = setup();
      const rand = random(seed);
      r.write("f.txt", seed % 3 === 0 ? body(60).slice(0, -1) : body(60));
      r.commit("init");
      r.write("f.txt", mutate(body(60), rand));
      const target = worktreeBlob(r, "f.txt");

      for (let i = 0; i < 200; i++) {
        const f = await r.file("unstaged", "f.txt");
        if (!f) break;
        const lines = seed % 2 ? hunkLines(f, 0) : allLines(f).filter(() => rand() < 0.3);
        await r.run("unstaged", "stage", f, lines.length ? lines : hunkLines(f, 0));
      }
      expect(await r.file("unstaged", "f.txt")).toBeUndefined();
      expect(indexBlob(r, "f.txt")).toBe(target);

      for (let i = 0; i < 200; i++) {
        const f = await r.file("staged", "f.txt");
        if (!f) break;
        await r.run("staged", "unstage", f, hunkLines(f, f.hunks.length - 1));
      }
      expect(indexBlob(r, "f.txt")).toBe(r.git("rev-parse", "HEAD:f.txt"));

      for (let i = 0; i < 200; i++) {
        const f = await r.file("unstaged", "f.txt");
        if (!f) break;
        const lines = allLines(f).filter(() => rand() < 0.4);
        await r.run("unstaged", "discard", f, lines.length ? lines : hunkLines(f, 0));
      }
      expect(worktreeBlob(r, "f.txt")).toBe(indexBlob(r, "f.txt"));
    });
  }
});

describe("staging special files", () => {
  it("stages part of an untracked file and keeps its exec bit", async () => {
    const r = setup();
    r.write("keep.txt", "keep\n");
    r.commit("init");
    writeFileSync(join(r.root, "new.sh"), "one\ntwo\nthree", { mode: 0o755 });
    const f = (await r.file("unstaged", "new.sh"))!;
    expect(await r.run("unstaged", "stage", f, [{ hunk: 0, line: 0 }])).toBe("Staged 1 line in new.sh");
    expect(r.git("show", ":new.sh")).toBe("one");
    expect(r.git("ls-files", "-s", "new.sh")).toMatch(/^100755 /);
    const rest = (await r.file("unstaged", "new.sh"))!;
    expect(await r.run("unstaged", "stage", rest, allLines(rest))).toBe("Staged new.sh");
    expect(indexBlob(r, "new.sh")).toBe(worktreeBlob(r, "new.sh"));
  });

  it("stages a deletion and a binary file whole", async () => {
    const r = setup();
    r.write("gone.txt", "bye\n");
    r.write("bin.dat", Buffer.from([0, 1, 2]));
    r.commit("init");
    rmSync(join(r.root, "gone.txt"));
    r.write("bin.dat", Buffer.from([0, 9, 9]));
    await r.run("unstaged", "stage", (await r.file("unstaged", "gone.txt"))!, null);
    await r.run("unstaged", "stage", (await r.file("unstaged", "bin.dat"))!, null);
    expect(r.git("diff", "--cached", "--name-status")).toBe("M\tbin.dat\nD\tgone.txt");
  });

  it("unstages part of a rename, then the whole rename", async () => {
    const r = setup();
    r.write("old.txt", body(20));
    r.commit("init");
    r.git("mv", "old.txt", "new.txt");
    r.write("new.txt", body(20).replace("line 3\n", "line three\n").replace("line 17\n", "line seventeen\n"));
    r.git("add", "new.txt");
    const f = (await r.file("staged", "new.txt"))!;
    expect(f).toMatchObject({ status: "renamed", oldPath: "old.txt" });
    await r.run("staged", "unstage", f, hunkLines(f, 0));
    expect(r.git("show", ":new.txt")).not.toContain("line three");
    expect(r.git("show", ":new.txt")).toContain("line seventeen");
    await r.run("staged", "unstage", (await r.file("staged", "new.txt"))!, null);
    expect(r.git("diff", "--cached", "--name-status")).toBe("");
  });

  it("stages and discards untracked files past the read limit", async () => {
    const r = setup();
    r.write("a.txt", "a\n");
    r.commit("init");
    for (let i = 0; i <= UNTRACKED_READ_LIMIT + 1; i++) r.write(`node_modules/m${String(i).padStart(5, "0")}.js`, "x\n");
    const [stage, discard] = (await diff(r.root, { kind: "unstaged" })).files.slice(-2);
    expect(stage).toMatchObject({ unread: true });
    expect(await r.run("unstaged", "stage", stage, null)).toBe(`Staged ${basename(stage.path)}`);
    expect(r.git("ls-files", "node_modules")).toBe(stage.path);
    await r.run("unstaged", "discard", discard, null);
    expect(existsSync(join(r.root, discard.path))).toBe(false);
  });

  it("unstages a new file in a repo with no commits", async () => {
    const r = setup();
    r.write("first.txt", "hello\n");
    r.git("add", "first.txt");
    await r.run("staged", "unstage", (await r.file("staged", "first.txt"))!, null);
    expect(r.git("ls-files")).toBe("");
  });
});

describe("safety", () => {
  it("won't stage part of a file whose new lines aren't UTF-8", async () => {
    const r = setup();
    r.write("a.txt", "one\ntwo\n");
    r.commit("init");
    r.write("a.txt", Buffer.from("one\ncaf\xe9\ntwo\nthree\n", "latin1"));
    const f = (await r.file("unstaged", "a.txt"))!;
    await expect(r.run("unstaged", "stage", f, [allLines(f)[0]])).rejects.toThrow("isn't UTF-8");
    expect(r.git("diff", "--cached")).toBe("");
  });

  it("refuses when the file changed since the diff was read", async () => {
    const r = setup();
    r.write("a.txt", body(10));
    r.commit("init");
    r.write("a.txt", body(10).replace("line 5", "five"));
    const f = (await r.file("unstaged", "a.txt"))!;
    r.write("a.txt", body(10).replace("line 5", "FIVE"));
    await expect(r.run("unstaged", "stage", f, null)).rejects.toThrow("a.txt changed since you looked");
    expect(r.git("diff", "--cached")).toBe("");
  });

  it("refuses actions that don't belong to the view, and context-only selections", async () => {
    const r = setup();
    r.write("a.txt", "a\nb\n");
    r.commit("init");
    r.write("a.txt", "a\nc\n");
    const f = (await r.file("unstaged", "a.txt"))!;
    await expect(r.run("unstaged", "stage", f, [{ hunk: 0, line: 0 }])).rejects.toThrow("No changed lines selected");
    await expect(r.run("unstaged", "unstage", f, null)).rejects.toThrow("Can't unstage in the unstaged view");
    await expect(r.run("staged", "discard", f, null)).rejects.toThrow("Can't discard in the staged view");
  });

  it("waits for another process's index lock", async () => {
    const r = setup();
    r.write("a.txt", "a\n");
    r.commit("init");
    r.write("a.txt", "b\n");
    const lock = join(r.root, ".git", "index.lock");
    writeFileSync(lock, "");
    setTimeout(() => rmSync(lock), 300);
    await r.run("unstaged", "stage", (await r.file("unstaged", "a.txt"))!, null);
    expect(r.git("show", ":a.txt")).toBe("b");
  });
});

describe("undo", () => {
  it("brings back discarded lines and a discarded untracked file", async () => {
    const r = setup();
    r.write("a.txt", body(20));
    r.commit("init");
    const edited = body(20).replace("line 2\n", "two\n").replace("line 15\n", "fifteen\n");
    r.write("a.txt", edited);
    r.write("scratch.txt", "notes\n");
    const f = (await r.file("unstaged", "a.txt"))!;
    await r.run("unstaged", "discard", f, hunkLines(f, 0));
    expect(readFileSync(join(r.root, "a.txt"), "utf8")).not.toContain("two");
    await r.run("unstaged", "discard", (await r.file("unstaged", "scratch.txt"))!, null);
    expect(existsSync(join(r.root, "scratch.txt"))).toBe(false);

    expect(await undo(r.root, r.log)).toBe("Discarded scratch.txt");
    expect(readFileSync(join(r.root, "scratch.txt"), "utf8")).toBe("notes\n");
    expect(await undo(r.root, r.log)).toBe("Discarded 2 lines in a.txt");
    expect(readFileSync(join(r.root, "a.txt"), "utf8")).toBe(edited);
    expect(await undo(r.root, r.log)).toBeNull();
  });

  it("undoes staging, and refuses once the file moved on", async () => {
    const r = setup();
    r.write("a.txt", "a\n");
    r.commit("init");
    r.write("a.txt", "b\n");
    await r.run("unstaged", "stage", (await r.file("unstaged", "a.txt"))!, null);
    expect(await undo(r.root, r.log)).toBe("Staged a.txt");
    expect(r.git("show", ":a.txt")).toBe("a");

    await r.run("unstaged", "stage", (await r.file("unstaged", "a.txt"))!, null);
    r.git("add", "a.txt");
    r.write("a.txt", "c\n");
    r.git("add", "a.txt");
    await expect(undo(r.root, r.log)).rejects.toThrow("a.txt changed since");
    expect(await undo(r.root, r.log)).toBeNull();
  });

  it("undoes staging a file with a tab in its name", async () => {
    const r = setup();
    r.write("a\tb.txt", "a\n");
    r.commit("init");
    r.write("a\tb.txt", "b\n");
    await r.run("unstaged", "stage", (await r.file("unstaged", "a\tb.txt"))!, null);
    expect(await undo(r.root, r.log)).toBe("Staged a\tb.txt");
    expect(r.git("diff", "--cached")).toBe("");
  });

  it("deletes a discarded git add -N file and brings it back untracked", async () => {
    const r = setup();
    r.write("a.txt", "a\n");
    r.commit("init");
    r.write("new.txt", "fresh\n");
    r.git("add", "-N", "new.txt");
    await r.run("unstaged", "discard", (await r.file("unstaged", "new.txt"))!, null);
    expect(existsSync(join(r.root, "new.txt"))).toBe(false);
    expect(r.git("status", "--porcelain")).toBe("");
    await undo(r.root, r.log);
    expect(readFileSync(join(r.root, "new.txt"), "utf8")).toBe("fresh\n");
  });

  it("refuses to undo a stage once someone else committed it", async () => {
    const r = setup();
    r.write("a.txt", "a\n");
    r.commit("init");
    r.write("a.txt", "b\n");
    await r.run("unstaged", "stage", (await r.file("unstaged", "a.txt"))!, null);
    r.git("commit", "-q", "-m", "agent");
    await expect(undo(r.root, r.log)).rejects.toThrow("a commit was made since");
    expect(r.git("diff", "--cached")).toBe("");
  });

  it("leaves the file alone when git has pruned the discard backup", async () => {
    const r = setup();
    r.write("a.txt", body(20));
    r.commit("init");
    const edited = body(20).replace("line 2\n", "two\n").replace("line 15\n", "fifteen\n");
    r.write("a.txt", edited);
    const f = (await r.file("unstaged", "a.txt"))!;
    await r.run("unstaged", "discard", f, hunkLines(f, 0));
    const kept = readFileSync(join(r.root, "a.txt"), "utf8");
    r.git("gc", "-q", "--prune=now");
    await expect(undo(r.root, r.log)).rejects.toThrow("cleaned up its backup");
    expect(readFileSync(join(r.root, "a.txt"), "utf8")).toBe(kept);
  });
});

describe("staged markers in the all view", () => {
  it("marks staged lines and files", async () => {
    const r = setup();
    r.write("a.txt", body(20));
    r.write("b.txt", "b\n");
    r.commit("init");
    r.write("a.txt", body(20).replace("line 2\n", "two\n").replace("line 18\n", "eighteen\n"));
    r.write("b.txt", "B\n");
    r.git("add", "b.txt");
    r.write("c.txt", "new\n");
    const f = (await r.file("unstaged", "a.txt"))!;
    await r.run("unstaged", "stage", f, [{ hunk: 0, line: hunkLines(f, 0)[1].line }]);
    r.write("a.txt", `extra\n${readFileSync(join(r.root, "a.txt"), "utf8")}`);

    const all = (await diff(r.root, { kind: "all" })).files;
    expect(all.map((x) => `${x.path}:${x.staged}`)).toEqual(["a.txt:partial", "b.txt:full", "c.txt:none"]);
    const changed = all[0].hunks.flatMap((h) => h.lines.filter((l) => l.kind !== "ctx"));
    expect(changed.map((l) => `${l.kind} ${l.text}${l.staged ? " staged" : ""}`)).toEqual([
      "add extra",
      "del line 2",
      "add two staged",
      "del line 18",
      "add eighteen",
    ]);
  });
});

describe("commit", () => {
  it("commits the index, drops stage undo entries and reports hook failures", async () => {
    const r = setup();
    r.write("a.txt", "a\n");
    r.commit("init");
    r.write("a.txt", "b\n");
    await r.run("unstaged", "stage", (await r.file("unstaged", "a.txt"))!, null);
    expect(await commit(r.root, "Change a\n\nBody", r.log)).toMatch(/^[0-9a-f]{7,} Change a$/);
    expect(r.git("log", "-1", "--format=%B")).toBe("Change a\n\nBody");
    expect(await undo(r.root, r.log)).toBeNull();

    r.write(".git/hooks/pre-commit", "#!/bin/sh\necho 'lint failed' >&2\nexit 1\n");
    r.git("update-index", "--add", "--cacheinfo", `100644,${r.git("hash-object", "-w", "a.txt")},other.txt`);
    execFileSync("chmod", ["+x", join(r.root, ".git/hooks/pre-commit")]);
    await expect(commit(r.root, "Nope", r.log)).rejects.toThrow(/^lint failed$/);
  });
});
