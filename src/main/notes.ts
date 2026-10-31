import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { carryLines, changedLines, changedRegions, chapterRefs, hasChanges, newToOld, placeRange } from "../shared/chapters";
import type { AgentNotes, Chapter, ChapterSource, CompareMode, FileDiff, NoteRange, NotesFile, Placement, Screenshot } from "../shared/types";
import { changesSince, commitChanges, diff, git, gitBuffer, literal, sides, SIZE_LIMIT } from "./git";

const LIMIT = 200;
// Commits made here, by their reflog entry. Pulls and merges bring in other people's commits under other entries.
const OWN = /^(commit( \([a-z]+\))?|cherry-pick|revert):|\((pick|reword|edit|squash|fixup|continue)\):/;
const BUSY = ["rebase-merge", "rebase-apply", "MERGE_HEAD", "MERGE_AUTOSTASH", "CHERRY_PICK_HEAD", "REVERT_HEAD", "index.lock"];

const SCREENSHOT = /^\w[\w.-]*\.(png|jpe?g|gif|webp)$/i;

const gitPath = async (root: string, args: string[]) => resolve(root, (await git(root, args)).trim());
const tryGit = (root: string, args: string[]) => git(root, args).catch(() => null);
const commitOf = async (root: string, rev: string) => (await tryGit(root, ["rev-parse", "-q", "--verify", `${rev}^{commit}`]))?.trim() ?? null;
const readText = (path: string) => readFile(path, "utf8").catch(() => null);
const lines = (out: string) => out.split("\n").filter(Boolean);
const inRepo = (path: string) => !isAbsolute(path) && !path.split("/").includes("..");
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
  if (commit) {
    const file = await readFrom(await commitNotesPath(root, (await commitOf(root, commit)) ?? commit));
    return { ...file, notes: await withScreenshots(root, file.notes, false) };
  }
  const file = await readFrom(path);
  return file.notes ? { ...file, notes: await withScreenshots(root, file.notes, true), placed: await placements(root, file.notes.chapters) } : file;
}

export async function screenshotPath(root: string, file: string): Promise<string | null> {
  return SCREENSHOT.test(file) ? join(await gitPath(root, ["rev-parse", "--git-common-dir"]), "moire", "media", file) : null;
}

const mtimeOf = async (path: string) => (await stat(path).catch(() => null))?.mtimeMs ?? 0;

async function withScreenshots<T extends AgentNotes | null>(root: string, notes: T, againstWorktree: boolean): Promise<T> {
  if (!notes?.chapters.some((c) => c.screenshots)) return notes;
  const chapters = await Promise.all(
    notes.chapters.map(async (chapter) => {
      if (!chapter.screenshots) return chapter;
      const paths = chapter.ranges.map((r) => r.path).filter(inRepo);
      const edited = againstWorktree ? Math.max(0, ...(await Promise.all(paths.map((p) => mtimeOf(join(root, p)))))) : 0;
      const screenshots = await Promise.all(
        chapter.screenshots.map(async (shot): Promise<Screenshot> => {
          const path = await screenshotPath(root, shot.file);
          const taken = path ? await mtimeOf(path) : 0;
          if (!taken) return { ...shot, missing: true };
          return { ...shot, version: taken, ...(edited > taken ? { stale: true } : {}) };
        }),
      );
      return { ...chapter, screenshots };
    }),
  );
  return { ...notes, chapters };
}

export async function readRangeNotes(root: string, mode: Extract<CompareMode, { kind: "branches" }>): Promise<NotesFile> {
  const path = await notesPath(root);
  await settleInTurn(root, path);
  const { a, b } = await sides(root, mode);
  const end = b.kind === "commit" ? b.rev! : "worktree";
  const shas = await revList(root, [`${a.rev}..${b.rev ?? "HEAD"}`]);
  const read = await Promise.all(shas.map(async (sha) => ({ sha, file: await readCommit(root, sha) })));
  const noted = read.flatMap(({ sha, file }) => (file?.notes?.chapters.length ? [{ sha, notes: file.notes }] : []));
  const working = mode.worktree ? await readFrom(path) : null;
  const uncommitted = working?.notes;
  const problem = [working?.problem, ...read.map((c) => c.file?.problem)].find(Boolean);
  const empty: NotesFile = { path, notes: null, problem, commits: { noted: 0, total: shas.length } };
  if (!noted.length && !uncommitted?.chapters.length) return empty;

  const { files } = await diff(root, mode);
  const named = await commitNames(
    root,
    noted.map((c) => c.sha),
  );
  const chapters: Chapter[] = [];
  const placed: Placement[][] = [];
  const keep = (chapter: Chapter, at: Placement[]) => {
    if (!chapter.ranges.length || !hasChanges(files, chapter, at)) return;
    chapters.push(chapter);
    placed.push(at);
  };
  for (const { sha, notes } of noted) {
    const [own, later] = await Promise.all([commitChanges(root, sha), changesSince(root, sha, end)]);
    const source: ChapterSource = { ...named.get(sha)!, summary: notes.summary };
    const carry = async (r: NoteRange) => {
      const last = !r.lines && !own.some((f) => f.path === r.path) ? await lastChange(root, `${a.rev}..${sha}`, r.path) : null;
      return last
        ? carryRange(root, last, r, await commitChanges(root, last), await changesSince(root, last, end), files)
        : carryRange(root, sha, r, own, later, files);
    };
    for (const chapter of notes.chapters) {
      const ranges = (await Promise.all(chapter.ranges.map(carry))).flat();
      keep({ ...chapter, ranges, from: source }, ranges.map(placedAs));
    }
  }
  if (uncommitted?.chapters.length) {
    const [at, dirty] = await Promise.all([placements(root, uncommitted.chapters), changesSince(root, "HEAD", "worktree")]);
    const from: ChapterSource = { subject: "Uncommitted", summary: uncommitted.summary };
    for (const [i, chapter] of uncommitted.chapters.entries()) {
      const parts = await Promise.all(
        chapter.ranges.map(async (r, ri) =>
          r.lines
            ? [{ range: r, place: at[i][ri] }]
            : (await carryRange(root, "HEAD", r, dirty, [], files)).map((range) => ({ range, place: placedAs(range) })),
        ),
      );
      keep(
        { ...chapter, ranges: parts.flat().map((p) => p.range), from },
        parts.flat().map((p) => p.place),
      );
    }
  }
  if (!chapters.length) return empty;
  const sources = new Set(chapters.map((c) => c.from));
  const summary = sources.size === 1 ? chapters[0].from?.summary : undefined;
  const notes = await withScreenshots(root, { summary, chapters }, !!mode.worktree);
  return { path, notes, placed, problem, commits: { noted: noted.length, total: shas.length } };
}

// A chapter lands on the newest commit touching any of its files, so one of those files may have changed in an earlier commit.
async function lastChange(root: string, range: string, path: string): Promise<string | null> {
  return (await git(root, ["rev-list", "-n1", range, "--", ...literal([path])])).trim() || null;
}

const placedAs = (r: NoteRange): Placement => (r.lines ? { start: r.lines[0], end: r.lines[1] } : "all");

async function commitNames(root: string, shas: string[]): Promise<Map<string, ChapterSource>> {
  if (!shas.length) return new Map();
  const log = await git(root, ["log", "--no-walk=unsorted", "--format=%H%x1f%h%x1f%s", ...shas]);
  return new Map(
    lines(log).map((line) => {
      const [sha, short, subject] = line.split("\x1f");
      return [sha, { short, subject }];
    }),
  );
}

async function linesAt(root: string, sha: string, path: string): Promise<string[] | null> {
  const text = await gitBuffer(root, ["cat-file", "blob", `${sha}:${path}`]).catch(() => null);
  return text && text.toString("utf8").split("\n");
}

async function carryRange(root: string, sha: string, r: NoteRange, own: FileDiff[], later: FileDiff[], files: FileDiff[]): Promise<NoteRange[]> {
  const moved = later.find((f) => (f.oldPath ?? f.path) === r.path);
  const path = moved?.path ?? r.path;
  const target = files.find((f) => f.path === path);
  if (moved?.status === "deleted" || !target) return [];
  const carry = (at: [number, number]) => carryLines(moved?.hunks ?? [], at);
  const { code, ...rest } = r;
  const range = { ...rest, path };
  if (r.lines) {
    const at = code ? placeRange(r, await linesAt(root, sha, r.path)) : null;
    const lines = carry(at && at !== "lost" && at !== "all" ? [at.start, at.end] : r.lines);
    return lines ? [{ ...range, lines }] : [];
  }
  // "All of this file" meant this commit's changes, so a later stray edit to the file must not count as explained.
  const change = own.find((f) => f.path === r.path);
  if (!change) return [];
  if (!change.hunks.length) return moved?.hunks.length ? [] : [range];
  const regions = changedRegions(change.hunks).flatMap((at) => {
    const lines = carry(at);
    return lines ? [lines] : [];
  });
  const spans = regions.map(([start, end]) => ({ start, end }));
  if (!regions.length) return [];
  if (chapterRefs(target, spans, []).length === changedLines(target).length) return [range];
  return regions.map((lines, i) => (i ? { path, lines } : { ...range, lines }));
}

async function readFrom(path: string): Promise<NotesFile> {
  const text = await readText(path);
  if (text === null) return { path, notes: null };
  const { notes, problem } = parse(text, basename(path));
  return { path, notes, problem };
}

async function placements(root: string, chapters: Chapter[]): Promise<Placement[][]> {
  const cache = new Map<string, Promise<string[] | null>>();
  const linesOf = (path: string) => {
    if (!inRepo(path)) return Promise.resolve(null);
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
    const later = await changesSince(root, sha, "worktree");
    const kept = rawIndex.map((at) => raw!.chapters[at]);
    const inTree = kept.map((chapter) => asWorking(later, chapter));
    const left = await open(inTree.map((chapter) => toChapter(chapter)!));
    kept.forEach((chapter, i) => {
      if (left[i]) restored.push(inTree[i]);
      else if (pairs.has(sha)) send(pairs.get(sha)!, notes!.summary, chapter);
    });
  }

  const moved = new Set<number>();
  if (working?.notes) {
    const left = await open(working.notes.chapters);
    const mine = added.filter((sha) => own.has(sha)).reverse();
    const touched = await Promise.all(mine.map((sha) => touchedBy(root, sha)));
    for (const [i, c] of working.notes.chapters.entries()) {
      if (left[i]) continue;
      const at = touched.findIndex((paths) => c.ranges.some((r) => paths.has(r.path)));
      if (at < 0) continue;
      moved.add(working.rawIndex[i]);
      send(mine[at], working.notes.summary, await asCommitted(root, mine[at], working.raw!.chapters[working.rawIndex[i]]));
    }
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

// Chapters are written against the work tree, but a commit's notes use that commit's line numbers.
async function asCommitted(root: string, sha: string, chapter: unknown): Promise<unknown> {
  const { ranges } = chapter as { ranges: unknown[] };
  const later = await changesSince(root, sha, "worktree");
  const place = async (raw: unknown) => {
    const range = toRange(raw);
    const file = later.find((f) => f.path === range?.path);
    if (!range?.lines || !file || !inRepo(range.path)) return raw;
    const at = placeRange(range, await readLines(join(root, range.path)));
    if (at === "all" || at === "lost") return raw;
    const toCommit = newToOld(file.hunks);
    const [start, end] = [toCommit(at.start), toCommit(at.end)];
    return start && end ? { ...(raw as object), path: file.oldPath ?? range.path, lines: [start, end] } : raw;
  };
  return { ...(chapter as object), ranges: await Promise.all(ranges.map(place)) };
}

// A commit's chapters use its line numbers, so one leaving HEAD has to be judged and restored on the work tree's.
function asWorking(later: FileDiff[], chapter: unknown): unknown {
  const place = (raw: unknown) => {
    const range = toRange(raw);
    const file = later.find((f) => (f.oldPath ?? f.path) === range?.path);
    const lines = file && range?.lines ? carryLines(file.hunks, range.lines) : null;
    return file && lines ? { ...(raw as object), path: file.path, lines } : raw;
  };
  return { ...(chapter as object), ranges: (chapter as { ranges: unknown[] }).ranges.map(place) };
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
  const path = await commitNotesPath(root, sha);
  const text = await readText(path);
  return text === null ? null : parse(text, basename(path));
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

function parse(text: string, name = "notes.json"): Parsed {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { raw: null, notes: null, rawIndex: [], problem: `${name} isn't valid JSON (${(e as Error).message})` };
  }
  const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (!obj || !Array.isArray(obj.chapters)) return { raw: null, notes: null, rawIndex: [], problem: `${name} should hold an object with a "chapters" list` };
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
    problem: skipped ? `Skipped ${skipped} ${skipped === 1 ? "chapter" : "chapters"} without a title or any ranges in ${name}` : undefined,
  };
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

function toChapter(raw: unknown): Chapter | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  const title = str(c.title);
  const ranges = (Array.isArray(c.ranges) ? c.ranges : []).map(toRange).filter((r): r is NoteRange => r !== null);
  if (!title || !ranges.length) return null;
  const screenshots = (Array.isArray(c.screenshots) ? c.screenshots : []).map(toScreenshot).filter((s): s is Screenshot => s !== null);
  return { title, text: str(c.text) ?? "", ranges, ...(c.warn === true ? { warn: true } : {}), ...(screenshots.length ? { screenshots } : {}) };
}

function toScreenshot(raw: unknown): Screenshot | null {
  const s = (typeof raw === "string" ? { file: raw } : raw) as Record<string, unknown> | null;
  const file = s && typeof s === "object" ? str(s.file) : undefined;
  if (!s || !file) return null;
  const caption = str(s.caption);
  return { file, ...(caption ? { caption } : {}) };
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
