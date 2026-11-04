import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll } from "vitest";
import type { DiffLine, FileDiff, Hunk } from "../shared/types";

// Exec bits, symlinks, tabs in names and sh scripts don't work on Windows.
export const WIN = process.platform === "win32";

export const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

export function tempDir(prefix: string) {
  // The native call also expands Windows short names like RUNNER~1, which git never prints.
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

export function makeRepo() {
  const root = tempDir("moire-test-");
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  git("config", "commit.gpgsign", "false");
  const write = (path: string, content: string | Buffer) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  const commit = (msg: string) => {
    git("add", "-A");
    git("commit", "-q", "-m", msg);
    return git("rev-parse", "HEAD");
  };
  return { root, git, write, commit };
}

export type Repo = ReturnType<typeof makeRepo>;
export type Files = Record<string, string | Buffer>;

export function seed(committed: Files, edits: Files = {}) {
  const r = makeRepo();
  for (const [path, content] of Object.entries(committed)) r.write(path, content);
  const head = r.commit("init");
  for (const [path, content] of Object.entries(edits)) r.write(path, content);
  return { ...r, head };
}

// Body lines read as in a diff: a leading "-" is removed, "+" is added, anything else is context.
export function diffHunk(oldStart: number, body: string[], newStart = oldStart): Hunk {
  let [oldNo, newNo] = [oldStart, newStart];
  const lines = body.map((line): DiffLine => {
    const text = line.slice(1);
    if (line[0] === "-") return { kind: "del", text, oldNo: oldNo++ };
    if (line[0] === "+") return { kind: "add", text, newNo: newNo++ };
    return { kind: "ctx", text, oldNo: oldNo++, newNo: newNo++ };
  });
  return { oldStart, oldLines: oldNo - oldStart, newStart, newLines: newNo - newStart, header: "", lines };
}

export const chapterText = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
export const chapterHunks = [diffHunk(10, ["-line 10", "+line ten"]), diffHunk(20, ["-line 20"], 19), diffHunk(25, ["+extra"])];
export const chapterFile: FileDiff = { path: "a.ts", status: "modified", binary: false, additions: 2, deletions: 2, hunks: chapterHunks };
