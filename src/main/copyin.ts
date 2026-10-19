import { constants, copyFile, lstat, mkdir, readdir, readFile, readlink, realpath, rmdir, rm, symlink } from "node:fs/promises";
import { basename, isAbsolute, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ClashChoice, ClashDiff, CopyItem, CopyPlan, CopyResult, FileDiff } from "../shared/types";
import { git, SIZE_LIMIT } from "./git";
import { parseDiff } from "./parse";
import { record, serial, setWorktree, type Step, worktreeEntry } from "./stage";

const FILE_LIMIT = 2000;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
export const shownDir = (dir: string) => dir || "the repository root";
// Case-insensitive filesystems (macOS, Windows) resolve .GIT to the real .git.
const isGit = (name: string) => name.toLowerCase() === ".git";
const said = (e: unknown) => {
  const text = e instanceof Error ? e.message : String(e);
  return /[.!?]$/.test(text) ? text : `${text}.`;
};

function checkRelative(path: string, what: string) {
  const parts = path.split("/");
  if (isAbsolute(path) || path.includes("\\") || parts.includes("..") || parts.some(isGit)) throw new Error(`Can't copy into ${what}`);
}

export async function planCopy(root: string, sources: string[], dir: string): Promise<CopyPlan> {
  if (dir && !dir.endsWith("/")) throw new Error(`Can't copy into ${dir}`);
  checkRelative(dir, dir);
  await makeRealDirs(root, dir, null);
  const realTarget = await realpath(join(root, dir));

  const items: CopyItem[] = [];
  let skippedGitDirs = 0;
  const walk = async (source: string, dest: string) => {
    const st = await lstat(source);
    if (st.isSymbolicLink() || st.isFile()) {
      if (items.length >= FILE_LIMIT) throw new Error(`That's over ${FILE_LIMIT.toLocaleString("en")} files. Copy fewer at a time.`);
      items.push({ source, dest, clash: false });
    } else if (st.isDirectory()) {
      for (const entry of (await readdir(source)).sort()) {
        if (isGit(entry)) skippedGitDirs++;
        else await walk(join(source, entry), `${dest}/${entry}`);
      }
    }
  };
  for (const source of sources) {
    if (!isAbsolute(source)) throw new Error(`Can't read ${source}`);
    const name = basename(source);
    const st = await lstat(source).catch(() => null);
    if (!st) throw new Error(`Can't read ${name}. It may have moved.`);
    if (isGit(name)) {
      skippedGitDirs++;
      continue;
    }
    if (st.isDirectory() && `${realTarget}${sep}`.startsWith(`${await realpath(source)}${sep}`)) throw new Error(`Can't copy ${name} into itself`);
    await walk(source, dir + name);
  }

  const twice = (name: string) => new Error(`Two of the items are named ${basename(name)}, so they'd overwrite each other`);
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.dest.toLowerCase())) throw twice(item.dest);
    seen.add(item.dest.toLowerCase());
  }
  const blocked = new Map<string, boolean>();
  for (const item of items) {
    for (let i = item.dest.indexOf("/", dir.length); i >= 0; i = item.dest.indexOf("/", i + 1)) {
      const parent = item.dest.slice(0, i);
      if (seen.has(parent.toLowerCase())) throw twice(parent);
      if (!blocked.has(parent)) blocked.set(parent, (await lstat(join(root, parent)).catch(() => null))?.isDirectory() === false);
      if (blocked.get(parent)) throw new Error(`${parent} is a file, so ${basename(item.dest)} can't go in it`);
    }
    const there = await lstat(join(root, item.dest)).catch(() => null);
    if (there?.isDirectory()) throw new Error(`${item.dest} is a folder, so ${basename(item.source)} can't be copied over it`);
    item.clash = !!there;
    if (there && (await realpath(join(root, item.dest)).catch(() => "")) === (await realpath(item.source))) {
      throw new Error(`${basename(item.dest)} is already in ${shownDir(item.dest.slice(0, item.dest.lastIndexOf("/") + 1))}`);
    }
  }
  const ignored =
    !!dir &&
    (await git(root, ["check-ignore", "-q", "--", dir]).then(
      () => true,
      () => false,
    ));
  return { dir, sources, items, skippedGitDirs, ignored };
}

export function copyIn(root: string, plan: CopyPlan, decisions: Record<string, ClashChoice>): Promise<CopyResult> {
  return serial(() => runCopy(root, plan, decisions));
}

async function runCopy(root: string, plan: CopyPlan, decisions: Record<string, ClashChoice>): Promise<CopyResult> {
  const fresh = await planCopy(root, plan.sources, plan.dir);
  if (JSON.stringify(fresh.items) !== JSON.stringify(plan.items)) throw new Error("The files changed since. Nothing was copied.");
  const taken = new Set(fresh.items.map((i) => i.dest));
  const steps: Step[] = [];
  const made: string[] = [];
  const replaced: string[] = [];
  try {
    for (const item of fresh.items) {
      const choice = item.clash ? (decisions[item.dest] ?? "skip") : null;
      if (choice === "skip") continue;
      const dest = choice === "keep" ? await copyName(root, item.dest, taken) : item.dest;
      taken.add(dest);
      const full = join(root, dest);
      const step: Step = { path: dest, worktree: [choice === "replace" ? await worktreeEntry(root, dest, true) : null, null] };
      await makeRealDirs(root, dest.slice(0, dest.lastIndexOf("/") + 1), made);
      if (choice === "replace") {
        steps.push(step);
        await rm(full, { force: true });
      }
      const link = (await lstat(item.source)).isSymbolicLink() ? await readlink(item.source) : null;
      await (link === null ? copyFile(item.source, full, constants.COPYFILE_EXCL) : symlink(link, full)).catch((e: NodeJS.ErrnoException) => {
        throw e.code === "EEXIST" ? new Error(`${dest} appeared while copying`) : e;
      });
      if (choice !== "replace") steps.push(step);
      step.worktree![1] = await worktreeEntry(root, dest, false);
      if (choice === "replace") replaced.push(basename(dest));
    }
  } catch (e) {
    const lost: Step[] = [];
    for (const step of steps.toReversed()) await setWorktree(root, step.path, step.worktree![0]).catch(() => lost.push(step));
    for (const d of made.toReversed()) await rmdir(join(root, d)).catch(() => {});
    throw lost.length ? await recordFailedRestore(root, plan.dir, lost.toReversed(), e) : new Error(`${said(e)} Nothing was copied.`);
  }

  const notes = [
    plan.skippedGitDirs ? `Skipped ${plural(plan.skippedGitDirs, "nested .git folder")}.` : "",
    replaced.length ? `Replaced ${replaced.join(", ")}; undo restores ${replaced.length === 1 ? "it" : "them"}.` : "",
    plan.ignored ? "Git ignores this folder, so the copies won't show in Changed." : "",
  ].filter(Boolean);
  if (!steps.length) return { text: ["Nothing was copied.", ...notes].join(" "), copied: 0 };
  const label = `Copied ${plural(steps.length, "file")} into ${shownDir(plan.dir)}`;
  await record(root, { label, steps, dirs: made });
  return { text: [`${label}.`, ...notes].join(" "), copied: steps.length };
}

async function makeRealDirs(root: string, dir: string, made: string[] | null) {
  const parts = dir.split("/").filter(Boolean);
  for (let i = 1; i <= parts.length; i++) {
    const path = parts.slice(0, i).join("/");
    const st = await lstat(join(root, path)).catch(() => null);
    if (st?.isDirectory()) continue;
    if (st || !made) throw new Error(`${path}/ is no longer a folder in the repository`);
    await mkdir(join(root, path));
    made.push(path);
  }
}

async function recordFailedRestore(root: string, dir: string, lost: Step[], e: unknown): Promise<Error> {
  const names = lost.map((s) => s.path).join(", ");
  const steps = await Promise.all(
    lost.map(async (s): Promise<Step> => ({ path: s.path, worktree: [s.worktree![0], await worktreeEntry(root, s.path, false).catch(() => null)] })),
  );
  try {
    await record(root, { label: `Failed copy into ${shownDir(dir)}`, steps });
    return new Error(`${said(e)} Couldn't restore ${names}; undo tries again.`);
  } catch {
    const shas = lost.flatMap((s) => (s.worktree![0] ? [s.worktree![0].sha] : []));
    return new Error(`${said(e)} Couldn't restore ${names}${shas.length ? `; git has the old contents as ${shas.join(", ")}` : ""}.`);
  }
}

export async function copyName(root: string, path: string, taken: ReadonlySet<string>): Promise<string> {
  const cut = path.lastIndexOf("/") + 1;
  const name = path.slice(cut);
  const dot = name.indexOf(".", 1);
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  const takenLower = new Set([...taken].map((t) => t.toLowerCase()));
  for (let n = 1; ; n++) {
    const next = `${path.slice(0, cut)}${stem} copy${n === 1 ? "" : ` ${n}`}${ext}`;
    if (!takenLower.has(next.toLowerCase()) && !(await lstat(join(root, next)).catch(() => null))) return next;
  }
}

async function readSide(path: string): Promise<Buffer> {
  const st = await lstat(path);
  return st.isSymbolicLink() ? Buffer.from(await readlink(path), "utf8") : readFile(path);
}

export async function clashDiff(root: string, source: string, dest: string): Promise<ClashDiff> {
  checkRelative(dest, dest);
  if (!isAbsolute(source)) throw new Error(`Can't read ${source}`);
  const ours = join(root, dest);
  const [stA, stB] = await Promise.all([lstat(ours), lstat(source)]);
  const file: FileDiff = { path: source, oldPath: dest, status: "modified", binary: false, additions: 0, deletions: 0, hunks: [] };
  const sizes: [number, number] = [stA.size, stB.size];
  if (stA.size > SIZE_LIMIT || stB.size > SIZE_LIMIT) return { file: { ...file, tooLarge: true }, contents: null, sizes };
  const [a, b] = await Promise.all([readSide(ours), readSide(source)]);
  if ([a, b].some((buf) => buf.subarray(0, 8000).includes(0))) return { file: { ...file, binary: true }, contents: null, sizes };
  const args = ["diff", "--no-index", "--no-color", "--no-ext-diff", "--no-textconv", "-U3", "--src-prefix=a/", "--dst-prefix=b/", "--", ours, source];
  // --no-index exits 1 when the files differ.
  const out = await git(root, args).catch((e: { code?: number; stdout?: string }) => {
    if (e.code === 1 && typeof e.stdout === "string") return e.stdout;
    throw e;
  });
  const parsed = parseDiff(out)[0];
  if (parsed) Object.assign(file, { hunks: parsed.hunks, additions: parsed.additions, deletions: parsed.deletions });
  return { file, contents: { a: a.toString("utf8"), b: b.toString("utf8"), hidden: false }, sizes };
}

// A file manager's copy: text/uri-list, or GNOME's list with "copy" or "cut" on its first line.
export function fileUris(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("file://")) continue;
    try {
      const path = fileURLToPath(line);
      if (!out.includes(path)) out.push(path);
    } catch {}
  }
  return out;
}
