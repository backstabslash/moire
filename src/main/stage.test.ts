import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FileDiff, LineRef, StageRequest } from "../shared/types";
import { diff, UNTRACKED_READ_LIMIT } from "./git";
import { act, actAll, adoptLegacyUndo, commit, dropDiscarded, saveDiscarded, setWorktree, undo } from "./stage";
import { dirs, makeRepo } from "./test-repo";

type Repo = ReturnType<typeof makeRepo>;

function setup() {
  const r = makeRepo();
  const file = async (mode: "unstaged" | "staged" | "all", path: string) => (await diff(r.root, { kind: mode })).files.find((f) => f.path === path);
  const run = (mode: StageRequest["mode"], action: StageRequest["action"], f: FileDiff, lines: LineRef[] | null = null) =>
    act(r.root, { mode, action, file: f, lines });
  return { ...r, file, run };
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

  it("stages and discards a rename git doesn't know about yet as a whole", async () => {
    const r = setup();
    const edited = body(20).replace("line 3\n", "line three\n").replace("line 17\n", "line seventeen\n");
    r.write("old.txt", body(20));
    r.commit("init");
    renameSync(join(r.root, "old.txt"), join(r.root, "new.txt"));
    r.write("new.txt", edited);
    const f = (await r.file("unstaged", "new.txt"))!;
    expect(f).toMatchObject({ status: "renamed", oldPath: "old.txt" });
    await expect(r.run("unstaged", "stage", f, hunkLines(f, 0))).rejects.toThrow("new.txt can only be staged whole");
    await expect(r.run("unstaged", "discard", f, hunkLines(f, 0))).rejects.toThrow("new.txt can only be discarded whole");

    expect(await r.run("unstaged", "stage", f, null)).toBe("Staged new.txt");
    expect(r.git("diff", "--cached", "-M", "--name-status")).toMatch(/^R\d+\told.txt\tnew.txt$/);
    expect(await undo(r.root)).toEqual({ label: "Staged new.txt" });
    expect(r.git("diff", "--cached", "--name-status")).toBe("");

    await r.run("unstaged", "discard", (await r.file("unstaged", "new.txt"))!, null);
    expect(existsSync(join(r.root, "new.txt"))).toBe(false);
    expect(readFileSync(join(r.root, "old.txt"), "utf8")).toBe(body(20));
    expect(await undo(r.root)).toEqual({ label: "Discarded new.txt" });
    expect(existsSync(join(r.root, "old.txt"))).toBe(false);
    expect(readFileSync(join(r.root, "new.txt"), "utf8")).toBe(edited);
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

  it("keeps a renamed file when its discard can't get the index lock", async () => {
    const r = setup();
    r.write("old.txt", body(20));
    r.commit("init");
    renameSync(join(r.root, "old.txt"), join(r.root, "new.txt"));
    const f = (await r.file("unstaged", "new.txt"))!;
    writeFileSync(join(r.root, ".git", "index.lock"), "");
    await expect(r.run("unstaged", "discard", f, null)).rejects.toThrow("index.lock");
    expect(readFileSync(join(r.root, "new.txt"), "utf8")).toBe(body(20));
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

    expect(await undo(r.root)).toEqual({ label: "Discarded scratch.txt" });
    expect(readFileSync(join(r.root, "scratch.txt"), "utf8")).toBe("notes\n");
    expect(await undo(r.root)).toEqual({ label: "Discarded 2 lines in a.txt" });
    expect(readFileSync(join(r.root, "a.txt"), "utf8")).toBe(edited);
    expect(await undo(r.root)).toBeNull();
  });

  it("undoes staging, and refuses once the file moved on", async () => {
    const r = setup();
    r.write("a.txt", "a\n");
    r.commit("init");
    r.write("a.txt", "b\n");
    await r.run("unstaged", "stage", (await r.file("unstaged", "a.txt"))!, null);
    expect(await undo(r.root)).toEqual({ label: "Staged a.txt" });
    expect(r.git("show", ":a.txt")).toBe("a");

    await r.run("unstaged", "stage", (await r.file("unstaged", "a.txt"))!, null);
    r.git("add", "a.txt");
    r.write("a.txt", "c\n");
    r.git("add", "a.txt");
    await expect(undo(r.root)).rejects.toThrow("a.txt changed since");
    expect(await undo(r.root)).toBeNull();
  });

  it("undoes staging a file with a tab in its name", async () => {
    const r = setup();
    r.write("a\tb.txt", "a\n");
    r.commit("init");
    r.write("a\tb.txt", "b\n");
    await r.run("unstaged", "stage", (await r.file("unstaged", "a\tb.txt"))!, null);
    expect(await undo(r.root)).toEqual({ label: "Staged a\tb.txt" });
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
    await undo(r.root);
    expect(readFileSync(join(r.root, "new.txt"), "utf8")).toBe("fresh\n");
  });

  it("refuses to undo a stage once someone else committed it", async () => {
    const r = setup();
    r.write("a.txt", "a\n");
    r.commit("init");
    r.write("a.txt", "b\n");
    await r.run("unstaged", "stage", (await r.file("unstaged", "a.txt"))!, null);
    r.git("commit", "-q", "-m", "agent");
    await expect(undo(r.root)).rejects.toThrow("a commit was made since");
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
    r.git("update-ref", "-d", "refs/moire/discards");
    r.git("gc", "-q", "--prune=now");
    await expect(undo(r.root)).rejects.toThrow("cleaned up its backup");
    expect(readFileSync(join(r.root, "a.txt"), "utf8")).toBe(kept);
  });

  it("pins discard backups so git gc keeps them, and unpins them once undone", async () => {
    const r = setup();
    r.write("a.txt", "a\n");
    r.commit("init");
    r.write("a.txt", "precious\n");
    await r.run("unstaged", "discard", (await r.file("unstaged", "a.txt"))!, null);
    const backup = execFileSync("git", ["-C", r.root, "hash-object", "--stdin"], { input: "precious\n", encoding: "utf8" }).trim();
    expect(r.git("ls-tree", "refs/moire/discards")).toContain(backup);
    r.git("gc", "-q", "--prune=now");
    expect(await undo(r.root)).toEqual({ label: "Discarded a.txt" });
    expect(readFileSync(join(r.root, "a.txt"), "utf8")).toBe("precious\n");
    expect(r.git("for-each-ref", "refs/moire")).toBe("");
  });

  it("keeps a discard whose file changed since, and saves it next to the file", async () => {
    const r = setup();
    r.write("a.txt", body(10));
    r.commit("init");
    const edited = body(10).replace("line 5\n", "five\n");
    r.write("a.txt", edited);
    await r.run("unstaged", "discard", (await r.file("unstaged", "a.txt"))!, null);
    r.write("a.txt", "agent rewrote it\n");
    const refused = await undo(r.root);
    expect(refused).toMatchObject({ refused: 'Can\'t undo "Discarded a.txt": a.txt changed since.', saveAs: "a.txt.orig" });
    expect(readFileSync(join(r.root, "a.txt"), "utf8")).toBe("agent rewrote it\n");
    r.git("gc", "-q", "--prune=now");
    expect(await saveDiscarded(r.root, (refused as { id: string }).id)).toBe("Saved a.txt.orig");
    expect(readFileSync(join(r.root, "a.txt.orig"), "utf8")).toBe(edited);
    expect(r.git("for-each-ref", "refs/moire")).toBe("");
    expect(await undo(r.root)).toBeNull();
  });

  it("offers a refused discard again until it's dismissed, then undoes older entries", async () => {
    const r = setup();
    r.write("a.txt", "a\n");
    r.write("b.txt", "b\n");
    r.commit("init");
    r.write("a.txt", "A\n");
    r.write("b.txt", "B\n");
    await r.run("unstaged", "stage", (await r.file("unstaged", "b.txt"))!, null);
    await r.run("unstaged", "discard", (await r.file("unstaged", "a.txt"))!, null);
    r.write("a.txt", "again\n");
    const refused = (await undo(r.root)) as { id: string };
    expect(refused).toHaveProperty("refused");
    expect(await undo(r.root)).toMatchObject({ id: refused.id, saveAs: "a.txt.orig" });
    expect(r.git("for-each-ref", "--format=%(refname)", "refs/moire")).toBe("refs/moire/discards");
    await dropDiscarded(r.root, refused.id);
    expect(r.git("for-each-ref", "refs/moire")).toBe("");
    expect(existsSync(join(r.root, "a.txt.orig"))).toBe(false);
    expect(await undo(r.root)).toEqual({ label: "Staged b.txt" });
    expect(await undo(r.root)).toBeNull();
  });
});

describe("undo history", () => {
  const logOf = (r: Repo) => JSON.parse(readFileSync(join(r.root, ".git", "moire-undo.json"), "utf8")) as { label: string }[];

  it("lives in each repo, apart from other repos", async () => {
    const one = setup();
    const two = setup();
    for (const r of [one, two]) {
      r.write("a.txt", "a\n");
      r.commit("init");
      r.write("a.txt", "b\n");
      await r.run("unstaged", "stage", (await r.file("unstaged", "a.txt"))!, null);
    }
    expect(logOf(one).map((e) => e.label)).toEqual(["Staged a.txt"]);
    expect(await undo(one.root)).toEqual({ label: "Staged a.txt" });
    expect(await undo(one.root)).toBeNull();
    expect(await undo(two.root)).toEqual({ label: "Staged a.txt" });
  });

  it("keeps a worktree's history and backups apart, safe from gc in the main checkout", async () => {
    const r = setup();
    r.write("a.txt", "a\n");
    r.commit("init");
    const wt = `${r.root}-wt`;
    dirs.push(wt);
    r.git("worktree", "add", "-q", wt);
    writeFileSync(join(wt, "a.txt"), "worktree edit\n");
    const f = (await diff(wt, { kind: "unstaged" })).files[0];
    await act(wt, { mode: "unstaged", action: "discard", file: f, lines: null });
    expect(await undo(r.root)).toBeNull();
    expect(r.git("for-each-ref", "--format=%(refname)", "refs/moire")).toBe(`refs/moire/worktrees/${basename(wt)}/discards`);
    r.git("gc", "-q", "--prune=now");
    expect(await undo(wt)).toEqual({ label: "Discarded a.txt" });
    expect(readFileSync(join(wt, "a.txt"), "utf8")).toBe("worktree edit\n");
  });

  it("sets aside an unreadable history instead of overwriting it", async () => {
    const r = setup();
    r.write("a.txt", "a\n");
    r.commit("init");
    const log = join(r.root, ".git", "moire-undo.json");
    writeFileSync(log, "{ not json");
    expect(await undo(r.root)).toBeNull();
    expect(readFileSync(`${log}.bad`, "utf8")).toBe("{ not json");
  });

  it("keeps more discards than stages", async () => {
    const r = setup();
    r.write("a.txt", "a\n");
    r.commit("init");
    const discard = { id: "d", label: "Discarded old.txt", steps: [{ path: "old.txt", worktree: [null, null] }] };
    const stages = Array.from({ length: 150 }, (_, i) => ({ id: `s${i}`, label: `Staged ${i}`, steps: [{ path: "x", index: [null, null] }] }));
    writeFileSync(join(r.root, ".git", "moire-undo.json"), JSON.stringify([discard, ...stages]));
    r.write("a.txt", "b\n");
    await r.run("unstaged", "stage", (await r.file("unstaged", "a.txt"))!, null);
    const log = logOf(r);
    expect(log).toHaveLength(101);
    expect(log[0].label).toBe("Discarded old.txt");
    expect(log.at(-1)!.label).toBe("Staged a.txt");
  });

  it("adopts this repo's entries from the old shared undo.json", async () => {
    const r = setup();
    r.write("a.txt", "a\n");
    r.commit("init");
    r.write("a.txt", "b\n");
    r.git("add", "a.txt");
    const blob = (path: string) => ({ mode: "100644", sha: r.git("rev-parse", path) });
    const legacy = join(r.root, ".git", "legacy-undo.json");
    const other = { root: "/elsewhere", label: "Staged x", steps: [] };
    const head = r.git("rev-parse", "HEAD");
    writeFileSync(
      legacy,
      JSON.stringify([other, { root: r.root, label: "Staged a.txt", steps: [{ path: "a.txt", index: [blob("HEAD:a.txt"), blob(":a.txt")] }], head }]),
    );
    await adoptLegacyUndo(r.root, legacy);
    expect(JSON.parse(readFileSync(legacy, "utf8"))).toEqual([other]);
    expect(await undo(r.root)).toEqual({ label: "Staged a.txt" });
    expect(r.git("diff", "--cached")).toBe("");
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
    expect(await commit(r.root, "Change a\n\nBody")).toMatch(/^[0-9a-f]{7,} Change a$/);
    expect(r.git("log", "-1", "--format=%B")).toBe("Change a\n\nBody");
    expect(await undo(r.root)).toBeNull();

    r.write(".git/hooks/pre-commit", "#!/bin/sh\necho 'lint failed' >&2\nexit 1\n");
    r.git("update-index", "--add", "--cacheinfo", `100644,${r.git("hash-object", "-w", "a.txt")},other.txt`);
    execFileSync("chmod", ["+x", join(r.root, ".git/hooks/pre-commit")]);
    await expect(commit(r.root, "Nope")).rejects.toThrow(/^lint failed$/);
    r.write(".git/hooks/pre-commit", "#!/bin/sh\necho 'src/a.ts' >&2\necho '  1:1  error  no-undef' >&2\nexit 1\n");
    await expect(commit(r.root, "Nope")).rejects.toThrow(/^src\/a\.ts\n {2}1:1 {2}error {2}no-undef$/);
  });
});

describe("files staged, then changed again", () => {
  it("can stage the new edits", async () => {
    const r = setup();
    r.write("a.txt", body(20));
    r.commit("init");
    r.write("a.txt", body(20).replace("line 2\n", "line two\n"));
    await r.run("unstaged", "stage", (await r.file("unstaged", "a.txt"))!);
    await r.file("unstaged", "a.txt");
    r.write("a.txt", body(20).replace("line 2\n", "line two\n").replace("line 18\n", "line eighteen\n"));
    const f = (await r.file("unstaged", "a.txt"))!;
    expect(f.changedSinceStaged).toBe(true);
    expect(await r.run("unstaged", "stage", f, hunkLines(f, 0))).toBe("Staged a.txt");
  });
});

describe("whole files and views", () => {
  it("stages every file in the view as one undo step, and unstages them the same way", async () => {
    const r = setup();
    r.write("a.txt", "a\n");
    r.write("gone.txt", "bye\n");
    r.commit("init");
    r.write("a.txt", "A\n");
    rmSync(join(r.root, "gone.txt"));
    r.write("new.txt", "new\n");
    const files = (await diff(r.root, { kind: "unstaged" })).files;
    expect(await actAll(r.root, { mode: "unstaged", files })).toBe("Staged 3 files");
    expect(r.git("diff", "--cached", "--name-status")).toBe("M\ta.txt\nD\tgone.txt\nA\tnew.txt");
    expect(await undo(r.root)).toEqual({ label: "Staged 3 files" });
    expect(r.git("diff", "--cached")).toBe("");

    await actAll(r.root, { mode: "unstaged", files: (await diff(r.root, { kind: "unstaged" })).files });
    expect(await actAll(r.root, { mode: "staged", files: (await diff(r.root, { kind: "staged" })).files })).toBe("Unstaged 3 files");
    expect(r.git("diff", "--cached")).toBe("");
    expect(await undo(r.root)).toEqual({ label: "Unstaged 3 files" });
    expect(r.git("diff", "--cached", "--name-only")).toBe("a.txt\ngone.txt\nnew.txt");
  });

  it("refuses to stage all when any file changed since", async () => {
    const r = setup();
    r.write("a.txt", "a\n");
    r.write("b.txt", "b\n");
    r.commit("init");
    r.write("a.txt", "A\n");
    r.write("b.txt", "B\n");
    const files = (await diff(r.root, { kind: "unstaged" })).files;
    r.write("b.txt", "BB\n");
    await expect(actAll(r.root, { mode: "unstaged", files })).rejects.toThrow("b.txt changed since you looked");
    expect(r.git("diff", "--cached")).toBe("");
  });

  it("unstages all in a repo with no commits", async () => {
    const r = setup();
    r.write("a.txt", "a\n");
    r.write("b.txt", "b\n");
    r.git("add", "-A");
    expect(await actAll(r.root, { mode: "staged", files: (await diff(r.root, { kind: "staged" })).files })).toBe("Unstaged 2 files");
    expect(r.git("ls-files")).toBe("");
  });

  it("discards a whole binary file, and undo brings it back", async () => {
    const r = setup();
    r.write("bin.dat", Buffer.from([0, 1, 2]));
    r.commit("init");
    r.write("bin.dat", Buffer.from([0, 9, 9]));
    expect(await r.run("unstaged", "discard", (await r.file("unstaged", "bin.dat"))!, null)).toBe("Discarded bin.dat");
    expect(readFileSync(join(r.root, "bin.dat"))).toEqual(Buffer.from([0, 1, 2]));
    await undo(r.root);
    expect(readFileSync(join(r.root, "bin.dat"))).toEqual(Buffer.from([0, 9, 9]));
  });
});

describe("merge conflicts", () => {
  function conflicted() {
    const r = setup();
    r.write("c.txt", "base\n");
    r.commit("init");
    r.git("checkout", "-q", "-b", "other");
    r.write("c.txt", "theirs\n");
    r.commit("theirs");
    r.git("checkout", "-q", "main");
    r.write("c.txt", "ours\n");
    r.commit("ours");
    try {
      r.git("merge", "-q", "other");
    } catch {}
    return r;
  }

  it("refuses to stage a file that still has conflict markers", async () => {
    const r = conflicted();
    const f = (await r.file("unstaged", "c.txt"))!;
    expect(f.status).toBe("conflicted");
    await expect(r.run("unstaged", "stage", f, null)).rejects.toThrow("c.txt still has conflict markers");
    await expect(actAll(r.root, { mode: "unstaged", files: [f] })).rejects.toThrow("still has conflict markers");
    expect(r.git("ls-files", "-u")).not.toBe("");
  });

  it("stages a resolved file to mark it resolved, and undo brings the conflict back", async () => {
    const r = conflicted();
    const stages = r.git("ls-files", "-s", "c.txt");
    r.write("c.txt", "ours and theirs\n");
    expect(await r.run("unstaged", "stage", (await r.file("unstaged", "c.txt"))!, null)).toBe("Staged c.txt");
    expect(r.git("ls-files", "-u")).toBe("");
    expect(r.git("show", ":c.txt")).toBe("ours and theirs");
    expect(await undo(r.root)).toEqual({ label: "Staged c.txt" });
    expect(r.git("ls-files", "-s", "c.txt")).toBe(stages);
    expect(readFileSync(join(r.root, "c.txt"), "utf8")).toBe("ours and theirs\n");
  });

  it("still refuses to discard a conflicted file", async () => {
    const r = conflicted();
    await expect(r.run("unstaged", "discard", (await r.file("unstaged", "c.txt"))!, null)).rejects.toThrow("has merge conflicts");
  });
});

describe("files git converts", () => {
  it("refuses to discard single lines of a file with converted line endings, but discards it whole", async () => {
    const r = setup();
    r.git("config", "core.autocrlf", "true");
    r.write("a.txt", "one\r\ntwo\r\nthree\r\n");
    r.commit("init");
    r.write("a.txt", "one\r\n2\r\nthree\r\nfour\r\n");
    const f = (await r.file("unstaged", "a.txt"))!;
    await expect(r.run("unstaged", "discard", f, [allLines(f)[0]])).rejects.toThrow(
      "git converts a.txt (line endings or a filter), so it can only be discarded whole",
    );
    expect(await r.run("unstaged", "discard", f, null)).toBe("Discarded a.txt");
    expect(r.git("status", "--porcelain")).toBe("");
  });

  it("still discards single lines when git converts nothing", async () => {
    const r = setup();
    r.git("config", "core.autocrlf", "input");
    r.write("a.txt", "one\ntwo\n");
    r.commit("init");
    r.write("a.txt", "one\n2\nthree\n");
    const f = (await r.file("unstaged", "a.txt"))!;
    await r.run("unstaged", "discard", f, [allLines(f).at(-1)!]);
    expect(readFileSync(join(r.root, "a.txt"), "utf8")).toBe("one\n2\n");
  });
});

describe("submodules", () => {
  it("says a submodule can only be staged whole instead of failing in git", async () => {
    const sub = makeRepo();
    sub.write("a.txt", "one\n");
    sub.commit("init");
    const r = setup();
    r.write("keep.txt", "keep\n");
    r.commit("init");
    r.git("-c", "protocol.file.allow=always", "submodule", "add", "-q", sub.root, "sub");
    r.commit("add sub");

    writeFileSync(join(r.root, "sub", "a.txt"), "two\n");
    const dirty = (await r.file("unstaged", "sub"))!;
    expect(dirty).toMatchObject({ oldMode: "160000", newMode: "160000" });
    await expect(r.run("unstaged", "stage", dirty, [{ hunk: 0, line: 1 }])).rejects.toThrow("sub is a submodule and can only be staged whole");

    execFileSync("git", ["-C", join(r.root, "sub"), "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qam", "two"]);
    r.git("add", "sub");
    const moved = (await r.file("staged", "sub"))!;
    await expect(r.run("staged", "unstage", moved, [{ hunk: 0, line: 1 }])).rejects.toThrow("sub is a submodule and can only be unstaged whole");
    expect(await r.run("staged", "unstage", moved, null)).toBe("Unstaged sub");
  });
});

describe("setWorktree", () => {
  it("streams a blob into place with its mode, writes symlinks, and removes files", async () => {
    const r = setup();
    const big = Buffer.alloc(8 * 1024 * 1024, "x");
    const sha = execFileSync("git", ["-C", r.root, "hash-object", "-w", "--stdin"], { input: big, encoding: "utf8" }).trim();
    const link = execFileSync("git", ["-C", r.root, "hash-object", "-w", "--stdin"], { input: "target", encoding: "utf8" }).trim();
    symlinkSync("old", join(r.root, "a.bin"));
    await setWorktree(r.root, "a.bin", { mode: "100755", sha });
    expect(readFileSync(join(r.root, "a.bin")).equals(big)).toBe(true);
    expect(lstatSync(join(r.root, "a.bin")).mode & 0o777).toBe(0o755 & ~process.umask());
    await setWorktree(r.root, "deep/a.bin", { mode: "100644", sha });
    expect(lstatSync(join(r.root, "deep/a.bin")).mode & 0o111).toBe(0);
    await setWorktree(r.root, "a.bin", { mode: "120000", sha: link });
    expect(readlinkSync(join(r.root, "a.bin"))).toBe("target");
    await expect(setWorktree(r.root, "deep/a.bin", { mode: "100644", sha: "0".repeat(40) })).rejects.toThrow();
    expect(readdirSync(join(r.root, "deep"))).toEqual(["a.bin"]);
    await setWorktree(r.root, "deep/a.bin", null);
    expect(existsSync(join(r.root, "deep/a.bin"))).toBe(false);
  });
});
