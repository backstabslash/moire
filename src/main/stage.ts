import { readFileSync, writeFileSync } from "node:fs";
import { lstat, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { FileDiff, StageAction, StageRequest } from "../shared/types";
import { diff, git, gitBuffer, gitError, gitInput, literal } from "./git";
import { splice, StaleError } from "./splice";

interface Blob {
  mode: string;
  sha: string;
}

interface Step {
  path: string;
  index?: [Blob | null, Blob | null];
  worktree?: [Blob | null, Blob | null];
}

interface UndoEntry {
  root: string;
  label: string;
  steps: Step[];
  head?: string | null;
}

const LOG_LIMIT = 100;
const VERB: Record<StageAction, string> = { stage: "Staged", unstage: "Unstaged", discard: "Discarded" };

let queue: Promise<unknown> = Promise.resolve();

function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

export function act(root: string, req: StageRequest, logPath: string): Promise<string> {
  return serial(() => runAct(root, req, logPath));
}

export function undo(root: string, logPath: string): Promise<string | null> {
  return serial(() => runUndo(root, logPath));
}

export function commit(root: string, message: string, logPath: string): Promise<string> {
  return serial(async () => {
    try {
      await locked(() => gitInput(root, ["commit", "-q", "-F", "-"], message));
    } catch (e) {
      throw new Error(gitError(e));
    }
    writeLog(
      logPath,
      readLog(logPath).filter((e) => e.root !== root || e.steps.some((s) => s.worktree)),
    );
    return (await git(root, ["log", "-1", "--format=%h %s"])).trim();
  });
}

async function runAct(root: string, req: StageRequest, logPath: string): Promise<string> {
  const { mode, action, file } = req;
  if ((mode === "staged") !== (action === "unstage")) throw new Error(`Can't ${action} in the ${mode} view`);
  const name = basename(file.path);
  const stale = new Error(`${name} changed since you looked. Refreshed.`);
  const paths = file.oldPath ? [file.path, file.oldPath] : [file.path];
  const current = (await diff(root, { kind: mode }, paths)).files.find((f) => f.path === file.path);
  const same = file.unread ? current?.status === file.status : JSON.stringify(current) === JSON.stringify(file);
  if (!same) throw stale;
  await Promise.all(paths.map((p) => indexEntry(root, p)));

  const changed = file.hunks.flatMap((h, hi) => h.lines.flatMap((l, li) => (l.kind === "ctx" ? [] : [`${hi}:${li}`])));
  const picked = new Set((req.lines ?? []).map((r) => `${r.hunk}:${r.line}`).filter((k) => changed.includes(k)));
  const whole = req.lines === null || picked.size === changed.length;
  if (!whole && picked.size === 0) throw new Error("No changed lines selected");

  const kind = action === "discard" ? "worktree" : "index";
  const touched = action === "discard" ? [file.path] : paths;
  const read = (p: string, keep: boolean) => (kind === "index" ? indexEntry(root, p) : worktreeEntry(root, p, keep));
  const before = await Promise.all(touched.map((p) => read(p, true)));
  try {
    if (whole) await actWhole(root, action, file, paths);
    else await actLines(root, action, file, (h, i) => picked.has(`${h}:${i}`));
  } catch (e) {
    throw e instanceof StaleError ? stale : e;
  }
  const after = await Promise.all(touched.map((p) => read(p, false)));
  const head = kind === "index" ? await headSha(root) : undefined;

  const label = whole ? `${VERB[action]} ${name}` : `${VERB[action]} ${picked.size} ${picked.size === 1 ? "line" : "lines"} in ${name}`;
  const steps = touched.map((path, i): Step => ({ path, [kind]: [before[i], after[i]] }));
  writeLog(logPath, [...readLog(logPath), { root, label, steps, head }].slice(-LOG_LIMIT));
  return label;
}

async function actWhole(root: string, action: StageAction, file: FileDiff, paths: string[]) {
  const spec = literal(paths);
  if (action === "stage") {
    await locked(() => git(root, ["add", "-A", "--", ...spec]));
  } else if (action === "unstage") {
    const born = await git(root, ["rev-parse", "-q", "--verify", "HEAD"]).then(
      () => true,
      () => false,
    );
    await locked(() => git(root, born ? ["reset", "-q", "--", ...spec] : ["rm", "--cached", "-q", "--ignore-unmatch", "--", ...spec]));
  } else if (file.status === "untracked") {
    await rm(join(root, file.path), { force: true });
  } else if (file.status === "added") {
    // git add -N: checkout would leave an empty file, and the bare entry would show as deleted.
    await rm(join(root, file.path), { force: true });
    await setIndex(root, file.path, null);
  } else {
    await locked(() => git(root, ["checkout", "-q", "--", ...spec]));
  }
}

async function actLines(root: string, action: StageAction, file: FileDiff, selected: (hunk: number, line: number) => boolean) {
  const name = basename(file.path);
  if (file.binary || file.tooLarge) throw new Error(`${name} can only be ${VERB[action].toLowerCase()} whole`);
  if (file.hunks.some((h) => h.lines.some((l) => l.text.includes("\uFFFD")))) throw new Error(`${name} isn't UTF-8 text, so it can only be changed whole`);
  if (action === "discard") {
    const full = join(root, file.path);
    const st = await lstat(full).catch(() => null);
    if (st?.isSymbolicLink()) throw new Error(`${name} is a symlink and can only be discarded whole`);
    const base = st ? await readFile(full) : Buffer.alloc(0);
    await writeFile(full, splice(utf8(base, name), file.hunks, selected, "a"));
    return;
  }
  const entry = await indexEntry(root, file.path);
  if (entry?.mode === "120000") throw new Error(`${name} is a symlink and can only be ${VERB[action].toLowerCase()} whole`);
  const base = entry ? await gitBuffer(root, ["cat-file", "blob", entry.sha]) : Buffer.alloc(0);
  const text = splice(utf8(base, name), file.hunks, selected, action === "stage" ? "b" : "a");
  const sha = (await gitInput(root, ["hash-object", "-w", "--no-filters", "--stdin"], text)).trim();
  const mode = entry?.mode ?? ((await worktreeEntry(root, file.path, false))?.mode === "100755" ? "100755" : "100644");
  await setIndex(root, file.path, { mode, sha });
}

async function runUndo(root: string, logPath: string): Promise<string | null> {
  const log = readLog(logPath);
  const i = log.findLastIndex((e) => e.root === root);
  if (i < 0) return null;
  const entry = log[i];
  writeLog(logPath, log.toSpliced(i, 1));
  if (entry.steps.some((s) => s.index) && entry.head !== undefined && (await headSha(root)) !== entry.head) {
    throw new Error(`Can't undo "${entry.label}": a commit was made since. Dropped it from undo history.`);
  }
  for (const step of entry.steps) {
    const now = step.index ? await indexEntry(root, step.path) : await worktreeEntry(root, step.path, false);
    if (!same(now, (step.index ?? step.worktree)![1])) {
      throw new Error(`Can't undo "${entry.label}": ${basename(step.path)} changed since. Dropped it from undo history.`);
    }
    const backup = (step.index ?? step.worktree)![0];
    if (
      backup &&
      !(await git(root, ["cat-file", "-e", backup.sha]).then(
        () => true,
        () => false,
      ))
    ) {
      throw new Error(`Can't undo "${entry.label}": git has since cleaned up its backup of ${basename(step.path)}. Dropped it from undo history.`);
    }
  }
  for (const step of entry.steps) {
    if (step.index) await setIndex(root, step.path, step.index[0]);
    if (step.worktree) await setWorktree(root, step.path, step.worktree[0]);
  }
  return entry.label;
}

function same(x: Blob | null, y: Blob | null) {
  return x?.sha === y?.sha && x?.mode === y?.mode;
}

async function indexEntry(root: string, path: string): Promise<Blob | null> {
  const out = await git(root, ["ls-files", "-s", "-z", "--", ...literal([path])]);
  const entries = out
    .split("\0")
    .filter(Boolean)
    .map((rec) => {
      const tab = rec.indexOf("\t");
      const [mode, sha, stage] = rec.slice(0, tab).split(" ");
      return { mode, sha, stage, p: rec.slice(tab + 1) };
    })
    .filter((e) => e.p === path);
  if (entries.some((e) => e.stage !== "0")) throw new Error(`${basename(path)} has merge conflicts. Resolve them first.`);
  return entries[0] ? { mode: entries[0].mode, sha: entries[0].sha } : null;
}

async function worktreeEntry(root: string, path: string, keep: boolean): Promise<Blob | null> {
  const full = join(root, path);
  const st = await lstat(full).catch(() => null);
  if (!st) return null;
  const w = keep ? ["-w"] : [];
  if (st.isSymbolicLink()) {
    return { mode: "120000", sha: (await gitInput(root, ["hash-object", ...w, "--no-filters", "--stdin"], await readlink(full))).trim() };
  }
  if (!st.isFile()) throw new Error(`${basename(path)} is not a regular file`);
  const sha = (await git(root, ["hash-object", ...w, "--no-filters", "--", full])).trim();
  return { mode: st.mode & 0o111 ? "100755" : "100644", sha };
}

async function setIndex(root: string, path: string, blob: Blob | null) {
  const args = blob ? ["update-index", "--add", "--cacheinfo", `${blob.mode},${blob.sha},${path}`] : ["update-index", "--force-remove", "--", path];
  await locked(() => git(root, args));
}

async function setWorktree(root: string, path: string, blob: Blob | null) {
  const full = join(root, path);
  const content = blob && (await gitBuffer(root, ["cat-file", "blob", blob.sha]));
  await rm(full, { force: true });
  if (!blob || !content) return;
  await mkdir(dirname(full), { recursive: true });
  if (blob.mode === "120000") await symlink(content.toString("utf8"), full);
  else await writeFile(full, content, { mode: blob.mode === "100755" ? 0o755 : 0o644 });
}

async function locked<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= 20 || !String(e).includes("index.lock")) throw e;
      await sleep(100);
    }
  }
}

function headSha(root: string): Promise<string | null> {
  return git(root, ["rev-parse", "-q", "--verify", "HEAD"]).then(
    (out) => out.trim(),
    () => null,
  );
}

function utf8(buf: Buffer, name: string): string {
  const text = buf.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(buf)) throw new Error(`${name} isn't UTF-8 text, so it can only be changed whole`);
  return text;
}

function readLog(path: string): UndoEntry[] {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as UndoEntry[];
  } catch {
    return [];
  }
}

function writeLog(path: string, log: UndoEntry[]) {
  writeFileSync(path, JSON.stringify(log));
}
