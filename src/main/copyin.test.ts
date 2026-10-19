import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clashDiff, copyIn, fileUris, planCopy } from "./copyin";
import { undo } from "./stage";
import { dirs, makeRepo } from "./test-repo";

const hook = vi.hoisted(() => ({ beforeCopy: null as ((dest: string) => void) | null }));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    copyFile: (src: string, dest: string, mode?: number) => {
      hook.beforeCopy?.(dest);
      return fs.copyFile(src, dest, mode);
    },
  };
});
afterEach(() => {
  hook.beforeCopy = null;
});

function outside(files: Record<string, string>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "moire-src-")));
  dirs.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return (path: string) => join(root, path);
}

function setup() {
  const r = makeRepo();
  r.write("src/a.ts", "export const a = 1;\n");
  r.write("README.md", "# hi\n");
  r.commit("init");
  const read = (path: string) => readFileSync(join(r.root, path), "utf8");
  return { ...r, read };
}

describe("copying files in", () => {
  it("plans and copies files with no clashes, then undoes the copy", async () => {
    const r = setup();
    const src = outside({ "b.ts": "export const b = 2;\n", "run.sh": "#!/bin/sh\n" });
    chmodSync(src("run.sh"), 0o755);
    const plan = await planCopy(r.root, [src("b.ts"), src("run.sh")], "src/");
    expect(plan.items).toEqual([
      { source: src("b.ts"), dest: "src/b.ts", clash: false },
      { source: src("run.sh"), dest: "src/run.sh", clash: false },
    ]);
    expect(plan.ignored).toBe(false);
    expect(await copyIn(r.root, plan, {})).toEqual({ text: "Copied 2 files into src/.", copied: 2 });
    expect(r.read("src/b.ts")).toBe("export const b = 2;\n");
    expect(lstatSync(join(r.root, "src/run.sh")).mode & 0o111).toBeTruthy();
    expect(readFileSync(src("b.ts"), "utf8")).toBe("export const b = 2;\n");

    expect(await undo(r.root)).toMatchObject({ label: "Copied 2 files into src/" });
    expect(existsSync(join(r.root, "src/b.ts"))).toBe(false);
    expect(existsSync(join(r.root, "src/run.sh"))).toBe(false);
  });

  it("copies a folder recursively, keeps symlinks as links and skips nested .git folders", async () => {
    const r = setup();
    const src = outside({ "kit/one.txt": "1\n", "kit/deep/two.txt": "2\n", "kit/.git/HEAD": "ref\n", "kit/deep/.git/config": "x\n" });
    symlinkSync("one.txt", src("kit/link"));
    const plan = await planCopy(r.root, [src("kit")], "");
    expect(plan.items.map((i) => i.dest)).toEqual(["kit/deep/two.txt", "kit/link", "kit/one.txt"]);
    expect(plan.skippedGitDirs).toBe(2);
    const result = await copyIn(r.root, plan, {});
    expect(result.text).toBe("Copied 3 files into the repository root. Skipped 2 nested .git folders.");
    expect(readlinkSync(join(r.root, "kit/link"))).toBe("one.txt");
    expect(r.read("kit/deep/two.txt")).toBe("2\n");
    expect(existsSync(join(r.root, "kit/.git"))).toBe(false);

    await undo(r.root);
    expect(existsSync(join(r.root, "kit"))).toBe(false);
  });

  it("names Keep both copies after the original, and Skip leaves the file alone", async () => {
    const r = setup();
    r.write("src/a copy.ts", "taken\n");
    const src = outside({ "a.ts": "new a\n", "README.md": "new readme\n", "x.test.ts": "t\n" });
    r.write("x.test.ts", "old test\n");
    const plan = await planCopy(r.root, [src("a.ts")], "src/");
    expect(plan.items[0].clash).toBe(true);
    expect((await copyIn(r.root, plan, { "src/a.ts": "keep" })).text).toBe("Copied 1 file into src/.");
    expect(r.read("src/a copy 2.ts")).toBe("new a\n");
    expect(r.read("src/a.ts")).toBe("export const a = 1;\n");

    const both = await planCopy(r.root, [src("README.md"), src("x.test.ts")], "");
    await copyIn(r.root, both, { "README.md": "skip", "x.test.ts": "keep" });
    expect(r.read("README.md")).toBe("# hi\n");
    expect(r.read("x copy.test.ts")).toBe("t\n");

    const skipped = await planCopy(r.root, [src("README.md")], "");
    expect(await copyIn(r.root, skipped, { "README.md": "skip" })).toEqual({ text: "Nothing was copied.", copied: 0 });
  });

  it("brings a replaced file back on undo", async () => {
    const r = setup();
    const src = outside({ "a.ts": "replacement\n" });
    const plan = await planCopy(r.root, [src("a.ts")], "src/");
    expect((await copyIn(r.root, plan, { "src/a.ts": "replace" })).text).toBe("Copied 1 file into src/. Replaced a.ts; undo restores it.");
    expect(r.read("src/a.ts")).toBe("replacement\n");
    r.git("gc", "-q", "--prune=now");
    expect(await undo(r.root)).toMatchObject({ label: "Copied 1 file into src/" });
    expect(r.read("src/a.ts")).toBe("export const a = 1;\n");
  });

  it("refuses to undo a copy whose file was edited since", async () => {
    const r = setup();
    const src = outside({ "new.ts": "fresh\n" });
    await copyIn(r.root, await planCopy(r.root, [src("new.ts")], "src/"), {});
    writeFileSync(join(r.root, "src/new.ts"), "edited\n");
    await expect(undo(r.root)).rejects.toThrow('Can\'t undo "Copied 1 file into src/": new.ts changed since');
    expect(r.read("src/new.ts")).toBe("edited\n");
  });

  it("notes an ignored destination", async () => {
    const r = setup();
    r.write(".gitignore", "dist/\n");
    r.write("dist/app.js", "x\n");
    const src = outside({ "a.css": "a {}\n" });
    const plan = await planCopy(r.root, [src("a.css")], "dist/");
    expect(plan.ignored).toBe(true);
    expect((await copyIn(r.root, plan, {})).text).toBe("Copied 1 file into dist/. Git ignores this folder, so the copies won't show in Changed.");
  });

  it("refuses what it can't copy, and a plan the disk no longer matches", async () => {
    const r = setup();
    const src = outside({ "one/same.txt": "1\n", "two/same.txt": "2\n", "a.ts/inner.txt": "i\n", "file/src": "s\n" });
    await expect(planCopy(r.root, [src("one/same.txt"), src("two/same.txt")], "")).rejects.toThrow("Two of the items are named same.txt");
    await expect(planCopy(r.root, [src("one/same.txt")], "../")).rejects.toThrow("Can't copy into");
    await expect(planCopy(r.root, [src("one/same.txt")], ".git/")).rejects.toThrow("Can't copy into");
    await expect(planCopy(r.root, [join(r.root, "src")], "src/")).rejects.toThrow("Can't copy src into itself");
    await expect(planCopy(r.root, [join(r.root, "src/a.ts")], "src/")).rejects.toThrow("a.ts is already in src/");
    await expect(planCopy(r.root, [src("a.ts")], "src/")).rejects.toThrow("src/a.ts is a file, so inner.txt can't go in it");
    await expect(planCopy(r.root, [src("file/src")], "")).rejects.toThrow("src is a folder");
    await expect(planCopy(r.root, [src("one/same.txt"), src("missing.txt")], "")).rejects.toThrow("Can't read missing.txt");

    const plan = await planCopy(r.root, [src("one/same.txt")], "");
    r.write("same.txt", "appeared\n");
    await expect(copyIn(r.root, plan, {})).rejects.toThrow("The files changed since. Nothing was copied.");
    expect(r.read("same.txt")).toBe("appeared\n");
  });
});

describe("copying safely", () => {
  it("refuses an item that would land inside another, so nothing is written through a symlink", async () => {
    const r = setup();
    const away = outside({});
    const src = outside({ "s2/x/f": "f\n" });
    mkdirSync(src("s1"));
    symlinkSync(away(""), src("s1/x"));
    await expect(planCopy(r.root, [src("s1/x"), src("s2/x")], "")).rejects.toThrow("Two of the items are named x");
    await expect(planCopy(r.root, [src("s2/x"), src("s1/x")], "")).rejects.toThrow("Two of the items are named x");
  });

  it("won't write through a folder that became a symlink mid-copy, and rolls back", async () => {
    const r = setup();
    const away = outside({});
    const src = outside({ "a.txt": "a\n", "kit/f.txt": "f\n" });
    const plan = await planCopy(r.root, [src("a.txt"), src("kit")], "");
    hook.beforeCopy = (dest) => {
      if (basename(dest) === "a.txt") symlinkSync(away(""), join(r.root, "kit"));
    };
    await expect(copyIn(r.root, plan, {})).rejects.toThrow("kit/ is no longer a folder in the repository. Nothing was copied.");
    expect(readdirSync(away(""))).toEqual([]);
    expect(existsSync(join(r.root, "a.txt"))).toBe(false);
  });

  it("treats names that differ only in case as the same, and .GIT as .git", async () => {
    const r = setup();
    const src = outside({ "one/Notes.md": "1\n", "two/notes.md": "2\n", "dir/Kit/a": "a\n", "dir/kit/a": "b\n", "kit/.Git/HEAD": "ref\n", "kit/x": "x\n" });
    await expect(planCopy(r.root, [src("one/Notes.md"), src("two/notes.md")], "")).rejects.toThrow("Two of the items are named notes.md");
    await expect(planCopy(r.root, [src("dir/Kit"), src("dir/kit")], "")).rejects.toThrow("Two of the items are named a");
    mkdirSync(src("up/.GIT"), { recursive: true });
    const plan = await planCopy(r.root, [src("kit"), src("up/.GIT")], "");
    expect(plan.items.map((i) => i.dest)).toEqual(["kit/x"]);
    expect(plan.skippedGitDirs).toBe(2);
    await expect(planCopy(r.root, [src("kit/x")], ".GIT/")).rejects.toThrow("Can't copy into .GIT/");
    await expect(clashDiff(r.root, src("kit/x"), ".Git/config")).rejects.toThrow("Can't copy into .Git/config");
  });

  it("stops when a file appears mid-copy, leaving it alone and undoing the rest", async () => {
    const r = setup();
    const src = outside({ "a.txt": "a\n", "b.txt": "b\n" });
    symlinkSync("a.txt", src("link"));
    const plan = await planCopy(r.root, [src("a.txt"), src("b.txt"), src("link")], "");
    hook.beforeCopy = (dest) => {
      if (basename(dest) === "a.txt") r.write("b.txt", "agent\n");
    };
    await expect(copyIn(r.root, plan, {})).rejects.toThrow("b.txt appeared while copying. Nothing was copied.");
    expect(r.read("b.txt")).toBe("agent\n");
    expect(existsSync(join(r.root, "a.txt"))).toBe(false);

    rmSync(join(r.root, "b.txt"));
    const again = await planCopy(r.root, [src("a.txt"), src("link")], "");
    hook.beforeCopy = (dest) => {
      if (basename(dest) === "a.txt") symlinkSync("elsewhere", join(r.root, "link"));
    };
    await expect(copyIn(r.root, again, {})).rejects.toThrow("link appeared while copying. Nothing was copied.");
    expect(readlinkSync(join(r.root, "link"))).toBe("elsewhere");
    expect(existsSync(join(r.root, "a.txt"))).toBe(false);
    expect(await undo(r.root)).toBe(null);
  });

  it("puts a replaced file back when a later item fails", async () => {
    const r = setup();
    const src = outside({ "a.ts": "replacement\n", "b.ts": "b\n" });
    const plan = await planCopy(r.root, [src("a.ts"), src("b.ts")], "src/");
    hook.beforeCopy = (dest) => {
      if (basename(dest) === "b.ts") throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    };
    await expect(copyIn(r.root, plan, { "src/a.ts": "replace" })).rejects.toThrow("ENOSPC: no space left on device. Nothing was copied.");
    expect(r.read("src/a.ts")).toBe("export const a = 1;\n");
    expect(existsSync(join(r.root, "src/b.ts"))).toBe(false);
  });

  it("says which files it couldn't put back, and keeps their backups for undo", async () => {
    const r = setup();
    const src = outside({ "a.ts": "replacement\n", "b.ts": "b\n" });
    const plan = await planCopy(r.root, [src("a.ts"), src("b.ts")], "src/");
    hook.beforeCopy = (dest) => {
      if (basename(dest) !== "b.ts") return;
      chmodSync(join(r.root, "src"), 0o555);
      throw new Error("disk full");
    };
    try {
      await expect(copyIn(r.root, plan, { "src/a.ts": "replace" })).rejects.toThrow("disk full. Couldn't restore src/a.ts; undo tries again.");
    } finally {
      chmodSync(join(r.root, "src"), 0o755);
    }
    const backup = execFileSync("git", ["-C", r.root, "hash-object", "--stdin"], { input: "export const a = 1;\n", encoding: "utf8" }).trim();
    expect(r.git("ls-tree", "refs/moire/discards")).toContain(backup);
    r.git("gc", "-q", "--prune=now");
    expect(await undo(r.root)).toMatchObject({ label: "Failed copy into src/" });
    expect(r.read("src/a.ts")).toBe("export const a = 1;\n");
  });
});

describe("clashDiff", () => {
  it("diffs the repo's file against the incoming one", async () => {
    const r = setup();
    const src = outside({ "a.ts": "export const a = 2;\n", "bin.dat": "\0\0\0" });
    const { file, contents } = await clashDiff(r.root, src("a.ts"), "src/a.ts");
    expect(file).toMatchObject({ path: src("a.ts"), oldPath: "src/a.ts", status: "modified", additions: 1, deletions: 1 });
    expect(file.hunks[0].lines.map((l) => `${l.kind} ${l.text}`)).toEqual(["del export const a = 1;", "add export const a = 2;"]);
    expect(contents).toEqual({ a: "export const a = 1;\n", b: "export const a = 2;\n", hidden: false });

    const bin = await clashDiff(r.root, src("bin.dat"), "src/a.ts");
    expect(bin.file.binary).toBe(true);
    expect(bin.sizes).toEqual([20, 3]);
  });
});

describe("fileUris", () => {
  it("reads uri lists and GNOME's copied files", () => {
    expect(fileUris("file:///tmp/a%20b.txt\r\n# comment\r\nfile:///tmp/c\r\n")).toEqual(["/tmp/a b.txt", "/tmp/c"]);
    expect(fileUris("cut\nfile:///home/x/f.png")).toEqual(["/home/x/f.png"]);
    expect(fileUris("https://example.com\nplain text")).toEqual([]);
  });
});
