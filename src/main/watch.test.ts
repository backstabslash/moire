import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { makeRepo } from "./test-repo";
import { RepoWatcher } from "./watch";

let watcher: RepoWatcher | null = null;
afterEach(() => watcher?.close());

async function watching() {
  const r = makeRepo();
  r.write(".gitignore", "build/\n*.log\n");
  r.write("src/a.ts", "a\n");
  r.write("build/out.js", "x\n");
  r.commit("init");
  let changes = 0;
  watcher = new RepoWatcher(r.root, () => changes++);
  await watcher.start();
  const settle = async () => {
    await sleep(400);
    return changes;
  };
  return { ...r, settle };
}

describe("RepoWatcher", () => {
  it("reports one change for a burst of edits", async () => {
    const r = await watching();
    for (let i = 0; i < 5; i++) r.write("src/a.ts", `a${i}\n`);
    r.write("new.ts", "fresh\n");
    expect(await r.settle()).toBe(1);
  });

  it("ignores gitignored files and sees index changes", async () => {
    const r = await watching();
    r.write("build/out.js", "y\n");
    r.write("debug.log", "noise\n");
    expect(await r.settle()).toBe(0);
    r.write("src/a.ts", "b\n");
    await r.settle();
    r.git("add", "src/a.ts");
    expect(await r.settle()).toBe(2);
  });

  it("starts watching directories created after it started", async () => {
    const r = await watching();
    mkdirSync(join(r.root, "src", "deep"));
    writeFileSync(join(r.root, "src", "deep", "x.ts"), "x\n");
    expect(await r.settle()).toBe(1);
    writeFileSync(join(r.root, "src", "deep", "x.ts"), "changed\n");
    expect(await r.settle()).toBe(2);
  });

  it("sees files written deep inside a new directory tree", async () => {
    const r = await watching();
    mkdirSync(join(r.root, "a", "b", "c"), { recursive: true });
    writeFileSync(join(r.root, "a", "b", "c", "x.ts"), "x\n");
    expect(await r.settle()).toBe(1);
    writeFileSync(join(r.root, "a", "b", "c", "x.ts"), "changed\n");
    expect(await r.settle()).toBe(2);
  });

  it("sees a file written into a new directory a while after it was made", async () => {
    const r = await watching();
    mkdirSync(join(r.root, "a", "b", "c"), { recursive: true });
    expect(await r.settle()).toBe(1);
    writeFileSync(join(r.root, "a", "b", "c", "x.ts"), "x\n");
    expect(await r.settle()).toBe(2);
    mkdirSync(join(r.root, "a", "b", "d"));
    await r.settle();
    writeFileSync(join(r.root, "a", "b", "d", "y.ts"), "y\n");
    expect(await r.settle()).toBe(4);
  });

  it("doesn't watch new directories inside ignored ones", async () => {
    const r = await watching();
    mkdirSync(join(r.root, "build", "deep", "er"), { recursive: true });
    writeFileSync(join(r.root, "build", "deep", "er", "x.js"), "x\n");
    expect(await r.settle()).toBe(0);
    writeFileSync(join(r.root, "build", "deep", "er", "x.js"), "y\n");
    expect(await r.settle()).toBe(0);
  });
  it("sees files come and go in ignored folders open in the tree, but not their edits", async () => {
    const r = await watching();
    watcher!.setOpen(["build/"]);
    await sleep(100);
    r.write("build/new.js", "x\n");
    expect(await r.settle()).toBe(1);
    r.write("build/new.js", "y\n");
    expect(await r.settle()).toBe(1);
    watcher!.setOpen([]);
    await sleep(100);
    r.write("build/other.js", "x\n");
    expect(await r.settle()).toBe(1);
  });

  it("sees fetches and updates to remote branches", async () => {
    const r = await watching();
    mkdirSync(join(r.root, ".git", "refs", "remotes", "origin"), { recursive: true });
    writeFileSync(join(r.root, ".git", "FETCH_HEAD"), "");
    expect(await r.settle()).toBe(1);
    writeFileSync(join(r.root, ".git", "refs", "remotes", "origin", "main"), r.git("rev-parse", "HEAD") + "\n");
    expect(await r.settle()).toBe(2);
  });

  it("sees agent notes written into the git folder", async () => {
    const r = await watching();
    mkdirSync(join(r.root, ".git", "moire"));
    writeFileSync(join(r.root, ".git", "moire", "notes.json"), "{}");
    expect(await r.settle()).toBe(1);
    writeFileSync(join(r.root, ".git", "moire", "notes.json"), '{"notes": []}');
    expect(await r.settle()).toBe(2);
  });
});
