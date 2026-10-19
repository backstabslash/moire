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

async function commitNotesPath(root: string, sha: string): Promise<string> {
  return join(await gitPath(root, ["rev-parse", "--git-common-dir"]), "moire", "commits", `${sha}.json`);
}

export async function readNotes(root: string, commit?: string): Promise<NotesFile> {
  const path = await notesPath(root);
  await settleInTurn(root, path);
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

function settleInTurn(root: string, path: string): Promise<void> {
  const run = (settling.get(path) ?? Promise.resolve()).then(() => settle(root, path));
  const tail = run.catch(() => {});
  settling.set(path, tail);
  void tail.then(() => settling.get(path) === tail && settling.delete(path));
  return run;
}

type SeenHead = { kind: "never-seen" } | { kind: "no-commits" } | { kind: "commit"; sha: string };
type MoveResult = "settled" | "notes-rewritten-meanwhile";

function seenHead(headFileText: string | null): SeenHead {
  const sha = headFileText?.trim();
  if (sha === undefined) return { kind: "never-seen" };
  return sha ? { kind: "commit", sha } : { kind: "no-commits" };
}

const mayBeHalfWritten = (file: Parsed | null) => !!file && !file.raw;

async function settle(root: string, path: string): Promise<void> {
  const headFile = join(dirname(path), "head");
  const [head, headFileText, busy] = await Promise.all([commitOf(root, "HEAD"), readText(headFile), inProgress(root)]);
  const seen = seenHead(headFileText);
  const unchanged = head ? seen.kind === "commit" && seen.sha === head : seen.kind === "no-commits";
  if (busy || unchanged) return;
  const text = await readText(path);
  const working = text === null ? null : parse(text);
  if (mayBeHalfWritten(working)) return;
  if (head && (await move(root, path, head, seen, text, working)) === "notes-rewritten-meanwhile") return;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(headFile, (head ?? "") + "\n");
}

async function inProgress(root: string): Promise<boolean> {
  const paths = lines(await git(root, ["rev-parse", ...BUSY.flatMap((name) => ["--git-path", name])]));
  return paths.some((p) => existsSync(resolve(root, p)));
}

async function move(root: string, path: string, head: string, seen: SeenHead, text: string | null, working: Parsed | null): Promise<MoveResult> {
  const { added, gone } = await history(root, path, head, seen);
  const old = (await Promise.all(gone.map(async (sha) => ({ sha, file: await readCommit(root, sha) })))).filter((o) => o.file?.notes);
  if (!old.length && !working?.notes?.chapters.length) return "settled";
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
    const { raw, notes, rawIndex } = file!;
    const left = await open(notes!.chapters);
    notes!.chapters.forEach((_, i) => {
      if (left[i]) restored.push(raw!.chapters[rawIndex[i]]);
      else if (pairs.has(sha)) send(pairs.get(sha)!, notes!.summary, raw!.chapters[rawIndex[i]]);
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
      moved.add(working.rawIndex[i]);
      send(mine[at], working.notes!.summary, working.raw!.chapters[working.rawIndex[i]]);
    });
  }
  if (!moved.size && !restored.length && !into.size) return "settled";

  if ((await readText(path)) !== text) return "notes-rewritten-meanwhile";
  for (const [sha, { summary, chapters }] of into) await addToCommit(root, sha, summary, chapters);
  const known = new Set((working?.raw?.chapters ?? []).map((c) => JSON.stringify(c)));
  const chapters = [...(working?.raw?.chapters ?? []).filter((_, i) => !moved.has(i)), ...restored.filter((c) => !known.has(JSON.stringify(c)))];
  if (chapters.length) {
    await mkdir(dirname(path), { recursive: true });
    await writeJson(path, { ...working?.raw, chapters });
  } else await rm(path, { force: true });
  return "settled";
}

async function history(root: string, path: string, head: string, seen: SeenHead): Promise<{ added: string[]; gone: string[] }> {
  if (seen.kind === "no-commits") return { added: await revList(root, [head]), gone: [] };
  if (seen.kind === "never-seen") {
    const st = await stat(path).catch(() => null);
    return { added: st ? await revList(root, [`--since=@${Math.floor(st.mtimeMs / 1000)}`, head]) : [], gone: [] };
  }
  const was = seen.sha;
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
interface Parsed {
  raw: Raw | null;
  notes: AgentNotes | null;
  rawIndex: number[];
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
    return { raw: null, notes: null, rawIndex: [], problem: `notes.json isn't valid JSON (${(e as Error).message})` };
  }
  const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (!obj || !Array.isArray(obj.chapters)) return { raw: null, notes: null, rawIndex: [], problem: 'notes.json should hold an object with a "chapters" list' };
  const rawIndex: number[] = [];
  const kept: Chapter[] = [];
  obj.chapters.forEach((c, i) => {
    const chapter = toChapter(c);
    if (!chapter) return;
    rawIndex.push(i);
    kept.push(chapter);
  });
  const skipped = obj.chapters.length - kept.length;
  return {
    raw: obj as Raw,
    notes: { summary: str(obj.summary), chapters: kept },
    rawIndex,
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
