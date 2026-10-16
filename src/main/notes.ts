import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { hasChanges, placeRange } from "../shared/chapters";
import type { AgentNotes, Chapter, NoteRange, NotesFile, Placement } from "../shared/types";
import { diff, git, SIZE_LIMIT } from "./git";

const LIMIT = 200;
// Commits made here, by their reflog entry. Pulls and merges bring in other people's commits under other entries.
const OWN = /^(commit( \([a-z]+\))?|cherry-pick|revert):|\((pick|reword|edit|squash|fixup|continue)\):/;
const BUSY = ["rebase-merge", "rebase-apply", "MERGE_HEAD", "MERGE_AUTOSTASH", "CHERRY_PICK_HEAD", "REVERT_HEAD", "index.lock"];

const gitPath = async (root: string, args: string[]) => resolve(root, (await git(root, args)).trim());
const tryGit = (root: string, args: string[]) => git(root, args).catch(() => null);
const commitOf = async (root: string, rev: string) => (await tryGit(root, ["rev-parse", "-q", "--verify", `${rev}^{commit}`]))?.trim() ?? null;
const readText = (path: string) => readFile(path, "utf8").catch(() => null);
const lines = (out: string) => out.split("\n").filter(Boolean);
const revList = async (root: string, args: string[]) => lines(await git(root, ["rev-list", "--reverse", `-n${LIMIT}`, ...args, "--"]));

async function writeJson(path: string, data: unknown) {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + "\n");
  await rename(tmp, path);
}

export const notesPath = (root: string) => gitPath(root, ["rev-parse", "--git-path", "moire/notes.json"]);

// Committed chapters sit in the common git folder, so every worktree sees them, like the commits.
async function commitNotesPath(root: string, sha: string): Promise<string> {
  return join(await gitPath(root, ["rev-parse", "--git-common-dir"]), "moire", "commits", `${sha}.json`);
}

export async function readNotes(root: string, commit?: string): Promise<NotesFile> {
  const path = await notesPath(root);
  await settleOnce(root, path);
  if (commit) return readFrom(await commitNotesPath(root, (await commitOf(root, commit)) ?? commit));
  const file = await readFrom(path);
  return file.notes ? { ...file, placed: await placements(root, file.notes.chapters) } : file;
}

async function readFrom(path: string): Promise<NotesFile> {
  const text = await readText(path);
  if (text === null) return { path, notes: null };
  const { notes, problem } = parse(text);
  return { path, notes, problem };
}

// Where each range is in the work tree, found again by its code when lines above it changed.
async function placements(root: string, chapters: Chapter[]): Promise<Placement[][]> {
  const cache = new Map<string, Promise<string[] | null>>();
  const linesOf = (path: string) => {
    if (isAbsolute(path) || path.split("/").includes("..")) return Promise.resolve(null);
    if (!cache.has(path)) cache.set(path, readLines(join(root, path)));
    return cache.get(path)!;
  };
  return Promise.all(chapters.map((c) => Promise.all(c.ranges.map(async (r) => placeRange(r, r.lines ? await linesOf(r.path) : null)))));
}

async function readLines(path: string): Promise<string[] | null> {
  const st = await stat(path).catch(() => null);
  if (!st?.isFile() || st.size > SIZE_LIMIT) return null;
  const text = await readText(path);
  if (text === null) return null;
  const out = text.split("\n");
  if (out[out.length - 1] === "") out.pop();
  return out;
}

const settling = new Map<string, Promise<void>>();

// Two refreshes settling at once would both move the same chapters.
function settleOnce(root: string, path: string): Promise<void> {
  const run = (settling.get(path) ?? Promise.resolve()).then(() => settle(root, path));
  const tail = run.catch(() => {});
  settling.set(path, tail);
  void tail.then(() => settling.get(path) === tail && settling.delete(path));
  return run;
}

// Once HEAD moves, chapters with nothing left uncommitted move to the last commit made here that touched their
// files, and chapters of commits that were amended, rebased or reset follow them. Nothing is ever dropped.
async function settle(root: string, path: string): Promise<void> {
  const headFile = join(dirname(path), "head");
  const [head, seen, busy] = await Promise.all([commitOf(root, "HEAD"), readText(headFile), inProgress(root)]);
  // undefined: never looked at this repo; "": it had no commits yet.
  const was = seen?.trim();
  if (busy || was === (head ?? "")) return;
  const text = await readText(path);
  const working = text === null ? null : parse(text);
  // A file that doesn't parse may be half written; settle once the agent finishes it.
  if (working && !working.raw) return;
  if (head && !(await move(root, path, head, was, text, working))) return;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(headFile, (head ?? "") + "\n");
}

async function inProgress(root: string): Promise<boolean> {
  const paths = lines(await git(root, ["rev-parse", ...BUSY.flatMap((name) => ["--git-path", name])]));
  return paths.some((p) => existsSync(resolve(root, p)));
}

// Returns false when the agent rewrote notes.json meanwhile, so the next read settles again from the same HEAD.
async function move(root: string, path: string, head: string, was: string | undefined, text: string | null, working: Parsed | null) {
  const { added, gone } = await history(root, path, head, was);
  const old = (await Promise.all(gone.map(async (sha) => ({ sha, file: await readCommit(root, sha) })))).filter((o) => o.file?.notes);
  if (!old.length && !working?.notes?.chapters.length) return true;
  const [{ files }, own, pairs] = await Promise.all([
    diff(root, { kind: "all" }),
    ownCommits(root, added),
    pairCommits(
      root,
      old.map((o) => o.sha),
      added,
    ),
  ]);
  const open = async (chapters: Chapter[]) => {
    const placed = await placements(root, chapters);
    return chapters.map((c, i) => hasChanges(files, c, placed[i]));
  };

  const into = new Map<string, { summary?: string; chapters: unknown[] }>();
  const send = (sha: string, summary: string | undefined, chapter: unknown) => {
    const to = into.get(sha) ?? { summary, chapters: [] };
    to.chapters.push(chapter);
    into.set(sha, to);
  };
  const restored: unknown[] = [];
  for (const { sha, file } of old) {
    const { raw, notes, index } = file!;
    const left = await open(notes!.chapters);
    notes!.chapters.forEach((_, i) => {
      if (left[i]) restored.push(raw!.chapters[index[i]]);
      else if (pairs.has(sha)) send(pairs.get(sha)!, notes!.summary, raw!.chapters[index[i]]);
    });
  }

  const moved = new Set<number>();
  if (working?.notes) {
    const left = await open(working.notes.chapters);
    const mine = added.filter((sha) => own.has(sha)).reverse();
    const touched = await Promise.all(mine.map((sha) => touchedBy(root, sha)));
    working.notes.chapters.forEach((c, i) => {
      if (left[i]) return;
      const at = touched.findIndex((paths) => c.ranges.some((r) => paths.has(r.path)));
      if (at < 0) return;
      moved.add(working.index[i]);
      send(mine[at], working.notes!.summary, working.raw!.chapters[working.index[i]]);
    });
  }
  if (!moved.size && !restored.length && !into.size) return true;

  if ((await readText(path)) !== text) return false;
  for (const [sha, { summary, chapters }] of into) await addToCommit(root, sha, summary, chapters);
  const known = new Set((working?.raw?.chapters ?? []).map((c) => JSON.stringify(c)));
  const chapters = [...(working?.raw?.chapters ?? []).filter((_, i) => !moved.has(i)), ...restored.filter((c) => !known.has(JSON.stringify(c)))];
  if (chapters.length) {
    await mkdir(dirname(path), { recursive: true });
    await writeJson(path, { ...working?.raw, chapters });
  } else await rm(path, { force: true });
  return true;
}

// Commits since HEAD was last seen, oldest first, and the ones an amend, rebase or reset took out of history.
async function history(root: string, path: string, head: string, was: string | undefined): Promise<{ added: string[]; gone: string[] }> {
  if (was === "") return { added: await revList(root, [head]), gone: [] };
  if (was === undefined) {
    const st = await stat(path).catch(() => null);
    return { added: st ? await revList(root, [`--since=@${Math.floor(st.mtimeMs / 1000)}`, head]) : [], gone: [] };
  }
  if (!(await commitOf(root, was))) return { added: [], gone: [] };
  if ((await tryGit(root, ["merge-base", "--is-ancestor", was, head])) !== null) return { added: await revList(root, [`${was}..${head}`]), gone: [] };
  const base = (await tryGit(root, ["merge-base", was, head]))?.trim();
  const range = (tip: string) => (base ? [`${base}..${tip}`] : [tip]);
  return { added: await revList(root, range(head)), gone: await revList(root, range(was)) };
}

async function ownCommits(root: string, shas: string[]): Promise<Set<string>> {
  const log = shas.length ? await tryGit(root, ["reflog", "--format=%H%x1f%gs", `-n${LIMIT * 5}`, "HEAD"]) : null;
  if (!log?.trim()) return new Set(shas);
  const own = new Set(lines(log).flatMap((line) => (OWN.test(line.slice(line.indexOf("\x1f") + 1)) ? [line.slice(0, line.indexOf("\x1f"))] : [])));
  return new Set(shas.filter((sha) => own.has(sha)));
}

// The commit each rewritten one became: the only one for an amend, else the one with the same subject and author.
async function pairCommits(root: string, gone: string[], added: string[]): Promise<Map<string, string>> {
  if (!gone.length || !added.length) return new Map();
  if (gone.length === 1 && added.length === 1) return new Map([[gone[0], added[0]]]);
  const keyed = async (shas: string[]) =>
    lines(await git(root, ["log", "--no-walk=unsorted", "--format=%H%x1f%s%x1f%an", ...shas])).map((line) => {
      const at = line.indexOf("\x1f");
      return [line.slice(0, at), line.slice(at + 1)] as const;
    });
  const [before, after] = await Promise.all([keyed(gone), keyed(added)]);
  const once = (list: (readonly [string, string])[]) => {
    const count = new Map<string, number>();
    for (const [, key] of list) count.set(key, (count.get(key) ?? 0) + 1);
    return new Map(list.filter(([, key]) => count.get(key) === 1).map(([sha, key]) => [key, sha]));
  };
  const now = once(after);
  return new Map([...once(before)].flatMap(([key, sha]) => (now.has(key) ? [[sha, now.get(key)!] as const] : [])));
}

async function touchedBy(root: string, sha: string): Promise<Set<string>> {
  return new Set((await git(root, ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "-z", sha])).split("\0").filter(Boolean));
}

async function readCommit(root: string, sha: string): Promise<Parsed | null> {
  const text = await readText(await commitNotesPath(root, sha));
  return text === null ? null : parse(text);
}

async function addToCommit(root: string, sha: string, summary: string | undefined, chapters: unknown[]) {
  const dest = await commitNotesPath(root, sha);
  const before = (await readCommit(root, sha))?.raw;
  const had = before?.chapters ?? [];
  const seen = new Set(had.map((c) => JSON.stringify(c)));
  const fresh = chapters.filter((c) => !seen.has(JSON.stringify(c)));
  if (!fresh.length) return;
  await mkdir(dirname(dest), { recursive: true });
  await writeJson(dest, { ...before, summary: before?.summary ?? summary, chapters: [...had, ...fresh] });
}

type Raw = Record<string, unknown> & { chapters: unknown[] };
// raw is the file as written, so rewriting it keeps chapters moire skipped; index maps each shown chapter to it.
interface Parsed {
  raw: Raw | null;
  notes: AgentNotes | null;
  index: number[];
  problem?: string;
}

export function parseNotes(text: string): { notes: AgentNotes | null; problem?: string } {
  const { notes, problem } = parse(text);
  return { notes, problem };
}

function parse(text: string): Parsed {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { raw: null, notes: null, index: [], problem: `notes.json isn't valid JSON (${(e as Error).message})` };
  }
  const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (!obj || !Array.isArray(obj.chapters)) return { raw: null, notes: null, index: [], problem: 'notes.json should hold an object with a "chapters" list' };
  const index: number[] = [];
  const kept: Chapter[] = [];
  obj.chapters.forEach((c, i) => {
    const chapter = toChapter(c);
    if (!chapter) return;
    index.push(i);
    kept.push(chapter);
  });
  const skipped = obj.chapters.length - kept.length;
  return {
    raw: obj as Raw,
    notes: { summary: str(obj.summary), chapters: kept },
    index,
    problem: skipped ? `Skipped ${skipped} ${skipped === 1 ? "chapter" : "chapters"} without a title or any ranges` : undefined,
  };
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

function toChapter(raw: unknown): Chapter | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  const title = str(c.title);
  const ranges = (Array.isArray(c.ranges) ? c.ranges : []).map(toRange).filter((r): r is NoteRange => r !== null);
  if (!title || !ranges.length) return null;
  return { title, text: str(c.text) ?? "", ranges, ...(c.warn === true ? { warn: true } : {}) };
}

function toRange(raw: unknown): NoteRange | null {
  const r = (typeof raw === "string" ? { path: raw } : raw) as Record<string, unknown> | null;
  const path = r && typeof r === "object" ? str(r.path) : undefined;
  if (!r || !path) return null;
  const range: NoteRange = { path: path.replace(/^\.\//, "") };
  const lines = toLines(r.lines);
  if (lines) range.lines = lines;
  if (typeof r.code === "string" && r.code.trim()) range.code = r.code;
  const note = str(r.note);
  if (note) range.note = note;
  if (r.warn === true) range.warn = true;
  return range;
}

function toLines(raw: unknown): [number, number] | null {
  const list = typeof raw === "number" ? [raw] : Array.isArray(raw) ? raw : [];
  const [first, last = first] = list;
  if (!Number.isInteger(first) || !Number.isInteger(last) || first < 1) return null;
  return [Math.min(first, last), Math.max(first, last)];
}
