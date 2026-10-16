import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readlink, rename, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { FileDiff, StageAction, StageAllRequest, StageRequest, UndoResult } from "../shared/types";
import { diff, git, gitBuffer, gitError, gitInput, gitToFile, literal } from "./git";
import { splice, StaleError } from "./splice";

export interface Blob {
  mode: string;
  sha: string;
}

export interface Step {
  path: string;
  index?: [Blob | null, Blob | null];
  worktree?: [Blob | null, Blob | null];
  // The `mode sha stage` entries of a merge conflict that staging resolved.
  conflict?: string[];
}

interface UndoEntry {
  id: string;
  label: string;
  steps: Step[];
  head?: string | null;
  // Folders a copy created, shallowest first, removed again on undo when empty.
  dirs?: string[];
}

interface IndexState {
  blob: Blob | null;
  conflict?: string[];
}

interface Store {
  log: string;
  pin: string;
}

const STAGE_LIMIT = 100;
const DISCARD_LIMIT = 200;
const VERB: Record<StageAction, string> = { stage: "Staged", unstage: "Unstaged", discard: "Discarded" };

let queue: Promise<unknown> = Promise.resolve();

export function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

export function act(root: string, req: StageRequest): Promise<string> {
  return serial(() => runAct(root, req));
}

export function actAll(root: string, req: StageAllRequest): Promise<string> {
  return serial(() => runActAll(root, req));
}

export function undo(root: string): Promise<UndoResult | null> {
  return serial(() => runUndo(root));
}

export function saveDiscarded(root: string, id: string): Promise<string> {
  return serial(() => runSaveDiscarded(root, id));
}

export function dropDiscarded(root: string, id: string): Promise<void> {
  return serial(async () => {
    const store = await storeFor(root);
    const log = await readLog(store);
    await writeLog(
      root,
      store,
      log.filter((e) => e.id !== id),
      log,
    );
  });
}

export function commit(root: string, message: string): Promise<string> {
  return serial(async () => {
    try {
      await locked(() => gitInput(root, ["commit", "-q", "-F", "-"], message));
    } catch (e) {
      throw new Error(gitError(e));
    }
    const store = await storeFor(root);
    const log = await readLog(store);
    await writeLog(
      root,
      store,
      log.filter((e) => e.steps.some((s) => s.worktree)),
      log,
    );
    return (await git(root, ["log", "-1", "--format=%h %s"])).trim();
  });
}

// Before 0.1.1 a single undo.json in userData held the history of every repo.
export function adoptLegacyUndo(root: string, legacy: string): Promise<void> {
  return serial(async () => {
    const old = await readFile(legacy, "utf8")
      .then((text) => JSON.parse(text) as (Omit<UndoEntry, "id"> & { root: string })[])
      .catch(() => null);
    if (!Array.isArray(old) || !old.some((e) => e.root === root)) return;
    const live = await present(root, backups(old.filter((e) => e.root === root)));
    const mine = old
      .filter((e) => e.root === root && e.steps.every((s) => !s.worktree?.[0] || live.includes(s.worktree[0].sha)))
      .map((e): UndoEntry => ({ id: randomUUID(), label: e.label, steps: e.steps, head: e.head }));
    const store = await storeFor(root);
    const log = await readLog(store);
    await writeLog(root, store, [...mine, ...log], log);
    const rest = old.filter((e) => e.root !== root);
    if (rest.length) await writeFile(legacy, JSON.stringify(rest));
    else await rm(legacy, { force: true });
  });
}

const pathsOf = (file: FileDiff) => (file.oldPath ? [file.path, file.oldPath] : [file.path]);
// The full refresh marks files staged-then-changed; a refresh of some paths doesn't.
const seen = (f: FileDiff | undefined) => JSON.stringify(f && { ...f, changedSinceStaged: undefined, version: undefined });

async function checkSeen(root: string, mode: StageRequest["mode"], files: FileDiff[], paths: string[]) {
  const current = new Map((await diff(root, { kind: mode }, paths.length > 1000 ? [] : paths)).files.map((f) => [f.path, f]));
  const moved = files.find((f) => (f.unread ? current.get(f.path)?.status !== f.status : seen(current.get(f.path)) !== seen(f)));
  if (moved) throw new Error(`${basename(moved.path)} changed since you looked. Refreshed.`);
}

async function runAct(root: string, req: StageRequest): Promise<string> {
  const { mode, action, file } = req;
  if ((mode === "staged") !== (action === "unstage")) throw new Error(`Can't ${action} in the ${mode} view`);
  const name = basename(file.path);
  const paths = pathsOf(file);
  await checkSeen(root, mode, [file], paths);

  const changed = file.hunks.flatMap((h, hi) => h.lines.flatMap((l, li) => (l.kind === "ctx" ? [] : [`${hi}:${li}`])));
  const picked = new Set((req.lines ?? []).map((r) => `${r.hunk}:${r.line}`).filter((k) => changed.includes(k)));
  const whole = req.lines === null || picked.size === changed.length;
  if (!whole && picked.size === 0) throw new Error("No changed lines selected");
  if (whole && action !== "discard") return stageWhole(root, action, [file], paths, `${VERB[action]} ${name}`);

  const kind = action === "discard" ? "worktree" : "index";
  // In the unstaged view a rename is a deletion paired with an untracked file, so discard restores both.
  const touched = action === "discard" && file.status !== "renamed" ? [file.path] : paths;
  const read = (p: string, keep: boolean) => (kind === "index" ? indexEntry(root, p) : worktreeEntry(root, p, keep));
  const [before] = await Promise.all([
    Promise.all(touched.map((p) => read(p, true))),
    kind === "worktree" && Promise.all(paths.map((p) => indexEntry(root, p))),
  ]);
  try {
    if (whole) await discardWhole(root, file, paths);
    else await actLines(root, action, file, (h, i) => picked.has(`${h}:${i}`), before[0]);
  } catch (e) {
    throw e instanceof StaleError ? new Error(`${name} changed since you looked. Refreshed.`) : e;
  }
  const [after, head] = await Promise.all([Promise.all(touched.map((p) => read(p, false))), kind === "index" ? headSha(root) : undefined]);

  const label = whole ? `${VERB[action]} ${name}` : `${VERB[action]} ${picked.size} ${picked.size === 1 ? "line" : "lines"} in ${name}`;
  await record(root, { label, steps: touched.map((path, i): Step => ({ path, [kind]: [before[i], after[i]] })), head });
  return label;
}

async function runActAll(root: string, { mode, files }: StageAllRequest): Promise<string> {
  const action = mode === "staged" ? "unstage" : "stage";
  if (!files.length) throw new Error(`Nothing to ${action}`);
  const paths = [...new Set(files.flatMap(pathsOf))];
  await checkSeen(root, mode, files, paths);
  const label = files.length === 1 ? `${VERB[action]} ${basename(files[0].path)}` : `${VERB[action]} ${files.length} files`;
  return stageWhole(root, action, files, paths, label);
}

async function stageWhole(root: string, action: "stage" | "unstage", files: FileDiff[], paths: string[], label: string): Promise<string> {
  for (const f of files.filter((f) => f.status === "conflicted")) {
    const name = basename(f.path);
    if (action === "unstage") throw new Error(`${name} has merge conflicts. Resolve them first.`);
    if (await hasMarkers(join(root, f.path))) throw new Error(`${name} still has conflict markers. Resolve them first.`);
  }
  const before = await indexState(root, paths);
  const spec = literal(paths)
    .map((p) => `${p}\0`)
    .join("");
  const from = ["--pathspec-from-file=-", "--pathspec-file-nul"];
  if (action === "stage") await locked(() => gitInput(root, ["add", "-A", ...from], spec));
  else if (await headSha(root)) await locked(() => gitInput(root, ["reset", "-q", ...from], spec));
  else await locked(() => gitInput(root, ["rm", "--cached", "-q", "--ignore-unmatch", ...from], spec));
  const [after, head] = await Promise.all([indexState(root, paths), headSha(root)]);
  const steps = paths.flatMap((path): Step[] => {
    const [b, a] = [before.get(path)!, after.get(path)!];
    if (!b.conflict && same(b.blob, a.blob)) return [];
    return [{ path, index: [b.blob, a.blob], ...(b.conflict && { conflict: b.conflict }) }];
  });
  await record(root, { label, steps, head });
  return label;
}

async function hasMarkers(path: string): Promise<boolean> {
  const buf = await readFile(path).catch(() => null);
  return !!buf && !buf.subarray(0, 8000).includes(0) && /^(<{7}|>{7}|\|{7})( |\r?$)/m.test(buf.toString("utf8"));
}

async function discardWhole(root: string, file: FileDiff, paths: string[]) {
  if (file.status === "untracked") {
    await rm(join(root, file.path), { force: true });
  } else if (file.status === "renamed") {
    // Git steps first: if the index is locked, nothing is lost before the undo entry is written.
    await locked(() => git(root, ["checkout", "-q", "--", ...literal([file.oldPath!])]));
    await rm(join(root, file.path), { force: true });
  } else if (file.status === "added") {
    // git add -N: checkout would leave an empty file, and the bare entry would show as deleted.
    await setIndex(root, file.path, null);
    await rm(join(root, file.path), { force: true });
  } else {
    await locked(() => git(root, ["checkout", "-q", "--", ...literal(paths)]));
  }
}

async function actLines(root: string, action: StageAction, file: FileDiff, selected: (hunk: number, line: number) => boolean, entry: Blob | null) {
  const name = basename(file.path);
  const typeChanged = file.oldMode !== file.newMode && [file.oldMode, file.newMode].some((m) => m === "120000" || m === "160000");
  // Renames in the unstaged view pair an untracked file with a deletion, which line edits can't express.
  const untrackedRename = file.status === "renamed" && action !== "unstage";
  if (file.binary || file.tooLarge || untrackedRename || typeChanged) throw new Error(`${name} can only be ${VERB[action].toLowerCase()} whole`);
  if (file.hunks.some((h) => h.lines.some((l) => l.text.includes("\uFFFD")))) throw new Error(`${name} isn't UTF-8 text, so it can only be changed whole`);
  if (entry?.mode === "120000") throw new Error(`${name} is a symlink and can only be ${VERB[action].toLowerCase()} whole`);
  if (entry?.mode === "160000") throw new Error(`${name} is a submodule and can only be ${VERB[action].toLowerCase()} whole`);
  if (action === "discard") {
    const full = join(root, file.path);
    // The diff shows the file as git would store it, which only matches the bytes on disk when git converts nothing.
    if (entry && (await git(root, ["hash-object", "--", full])).trim() !== entry.sha) {
      throw new Error(`git converts ${name} (line endings or a filter), so it can only be discarded whole`);
    }
    const base = entry ? await readFile(full) : Buffer.alloc(0);
    await writeFile(full, splice(utf8(base, name), file.hunks, selected, "a"));
    return;
  }
  const base = entry ? await gitBuffer(root, ["cat-file", "blob", entry.sha]) : Buffer.alloc(0);
  const text = splice(utf8(base, name), file.hunks, selected, action === "stage" ? "b" : "a");
  const sha = (await gitInput(root, ["hash-object", "-w", "--no-filters", "--stdin"], text)).trim();
  const mode = entry?.mode ?? ((await worktreeEntry(root, file.path, false))?.mode === "100755" ? "100755" : "100644");
  await setIndex(root, file.path, { mode, sha });
}

async function runUndo(root: string): Promise<UndoResult | null> {
  const store = await storeFor(root);
  const log = await readLog(store);
  // A refused discard stays on top, so its Save or Dismiss is offered again rather than lost.
  const i = log.length - 1;
  if (i < 0) return null;
  const entry = log[i];
  const drop = async (why: string) => {
    await writeLog(root, store, log.toSpliced(i, 1), log);
    return new Error(`Can't undo "${entry.label}": ${why}. Dropped it from undo history.`);
  };
  const indexSteps = entry.steps.filter((s) => s.index);
  if (indexSteps.length && entry.head !== undefined && (await headSha(root)) !== entry.head) throw await drop("a commit was made since");
  for (const step of entry.steps) {
    const backup = step.worktree?.[0];
    if (backup && !(await present(root, [backup.sha])).length) throw await drop(`git has since cleaned up its backup of ${basename(step.path)}`);
  }
  const index = await indexState(
    root,
    indexSteps.map((s) => s.path),
  );
  for (const step of entry.steps) {
    const now: IndexState = step.index ? index.get(step.path)! : { blob: await worktreeEntry(root, step.path, false).catch(() => ({ mode: "", sha: "" })) };
    if (!now.conflict && same(now.blob, (step.index ?? step.worktree)![1])) continue;
    const kept = entry.steps.find((s) => s.worktree?.[0]);
    if (!kept) throw await drop(`${basename(step.path)} changed since`);
    return { refused: `Can't undo "${entry.label}": ${basename(step.path)} changed since.`, id: entry.id, saveAs: basename(await freeName(root, kept.path)) };
  }
  await restoreIndex(root, indexSteps);
  for (const step of entry.steps) if (step.worktree) await setWorktree(root, step.path, step.worktree[0]);
  for (const dir of (entry.dirs ?? []).toReversed()) await rmdir(join(root, dir)).catch(() => {});
  await writeLog(root, store, log.toSpliced(i, 1), log);
  return { label: entry.label };
}

async function runSaveDiscarded(root: string, id: string): Promise<string> {
  const store = await storeFor(root);
  const log = await readLog(store);
  const i = log.findIndex((e) => e.id === id);
  if (i < 0) throw new Error("That discard is no longer in undo history");
  const saved: string[] = [];
  for (const step of log[i].steps) {
    if (!step.worktree?.[0]) continue;
    const path = await freeName(root, step.path);
    await setWorktree(root, path, step.worktree[0]);
    saved.push(basename(path));
  }
  await writeLog(root, store, log.toSpliced(i, 1), log);
  return `Saved ${saved.join(", ")}`;
}

async function freeName(root: string, path: string): Promise<string> {
  for (let n = 1; ; n++) {
    const name = n === 1 ? `${path}.orig` : `${path}.orig.${n}`;
    if (!(await lstat(join(root, name)).catch(() => null))) return name;
  }
}

function same(x: Blob | null, y: Blob | null) {
  return x?.sha === y?.sha && x?.mode === y?.mode;
}

async function indexState(root: string, paths: string[]): Promise<Map<string, IndexState>> {
  const state = new Map(paths.map((p): [string, IndexState] => [p, { blob: null }]));
  if (!paths.length) return state;
  const out = await git(root, ["ls-files", "-s", "-z", ...(paths.length > 100 ? [] : ["--", ...literal(paths)])]);
  for (const rec of out.split("\0")) {
    const tab = rec.indexOf("\t");
    const entry = state.get(rec.slice(tab + 1));
    if (!rec || !entry) continue;
    const [mode, sha, stage] = rec.slice(0, tab).split(" ");
    if (stage === "0") entry.blob = { mode, sha };
    else (entry.conflict ??= []).push(rec.slice(0, tab));
  }
  return state;
}

async function indexEntry(root: string, path: string): Promise<Blob | null> {
  const entry = (await indexState(root, [path])).get(path)!;
  if (entry.conflict) throw new Error(`${basename(path)} has merge conflicts. Resolve them first.`);
  return entry.blob;
}

export async function worktreeEntry(root: string, path: string, keep: boolean): Promise<Blob | null> {
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

async function restoreIndex(root: string, steps: Step[]) {
  if (!steps.length) return;
  const lines = steps.flatMap(({ path, index, conflict }) => {
    const [want, now] = index!;
    const zero = "0".repeat((want?.sha ?? now?.sha ?? conflict![0].split(" ")[1]).length);
    if (conflict) return [`0 ${zero}\t${path}`, ...conflict.map((c) => `${c}\t${path}`)];
    return [want ? `${want.mode} ${want.sha} 0\t${path}` : `0 ${zero}\t${path}`];
  });
  await locked(() => gitInput(root, ["update-index", "-z", "--index-info"], lines.map((l) => `${l}\0`).join("")));
}

export async function setWorktree(root: string, path: string, blob: Blob | null) {
  const full = join(root, path);
  if (!blob) return void (await rm(full, { force: true }));
  if (blob.mode === "120000") {
    const target = (await gitBuffer(root, ["cat-file", "blob", blob.sha])).toString("utf8");
    await rm(full, { force: true });
    await mkdir(dirname(full), { recursive: true });
    return void (await symlink(target, full));
  }
  await mkdir(dirname(full), { recursive: true });
  const tmp = `${full}.${randomUUID()}`;
  try {
    await gitToFile(root, ["cat-file", "blob", blob.sha], tmp, blob.mode === "100755" ? 0o755 : 0o644);
    await rename(tmp, full);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
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

const stores = new Map<string, Promise<Store>>();

// Per worktree, like the index. Refs are shared between worktrees, so each pins its backups under its own name.
function storeFor(root: string): Promise<Store> {
  let store = stores.get(root);
  if (!store) {
    store = git(root, ["rev-parse", "--git-dir", "--git-common-dir"]).then((out) => {
      const [dir, common] = out
        .trim()
        .split("\n")
        .map((p) => resolve(root, p));
      return { log: join(dir, "moire-undo.json"), pin: dir === common ? "refs/moire/discards" : `refs/moire/worktrees/${basename(dir)}/discards` };
    });
    stores.set(root, store);
    void store.catch(() => stores.delete(root));
  }
  return store;
}

async function readLog(store: Store): Promise<UndoEntry[]> {
  let text: string;
  try {
    text = await readFile(store.log, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  try {
    return JSON.parse(text) as UndoEntry[];
  } catch {
    await rename(store.log, `${store.log}.bad`).catch(() => {});
    return [];
  }
}

export async function record(root: string, entry: Omit<UndoEntry, "id">) {
  const store = await storeFor(root);
  const log = await readLog(store);
  await writeLog(root, store, [...log, { id: randomUUID(), ...entry }], log);
}

async function writeLog(root: string, store: Store, next: UndoEntry[], before: UndoEntry[]) {
  const kept = new Set<UndoEntry>();
  let [stages, discards] = [0, 0];
  for (const e of next.toReversed()) {
    if (e.steps.some((s) => s.worktree) ? discards++ < DISCARD_LIMIT : stages++ < STAGE_LIMIT) kept.add(e);
  }
  const log = next.filter((e) => kept.has(e));
  const tmp = `${store.log}.${randomUUID()}`;
  try {
    await writeFile(tmp, JSON.stringify(log));
    await rename(tmp, store.log);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
  const want = backups(log);
  // A failed pin costs nothing yet: git keeps unreachable objects for two weeks, and the next update pins them again.
  if (want.join() !== backups(before).join()) await pin(root, store.pin, want).catch(() => {});
}

function backups(log: Pick<UndoEntry, "steps">[]): string[] {
  return [...new Set(log.flatMap((e) => e.steps.flatMap((s) => (s.worktree?.[0] ? [s.worktree[0].sha] : []))))].sort();
}

async function present(root: string, shas: string[]): Promise<string[]> {
  if (!shas.length) return [];
  const out = await gitInput(root, ["cat-file", "--batch-check"], shas.map((s) => `${s}\n`).join(""));
  return out.split("\n").flatMap((line) => (/^\S+ blob /.test(line) ? [line.split(" ")[0]] : []));
}

// A tree of the live discard backups, so git gc can't prune them while undo may still need them.
async function pin(root: string, ref: string, shas: string[]) {
  const live = await present(root, shas);
  if (!live.length) return void (await git(root, ["update-ref", "-d", ref]));
  const tree = await gitInput(root, ["mktree", "-z"], live.map((sha) => `100644 blob ${sha}\t${sha}\0`).join(""));
  await git(root, ["update-ref", ref, tree.trim()]);
}
