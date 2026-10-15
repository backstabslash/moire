import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, open, readdir, readFile, readlink, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve as resolvePath } from "node:path";
import { promisify } from "node:util";
import type {
  CommitDetail,
  CommitInfo,
  CompareMode,
  DiffResult,
  FileContents,
  FileDiff,
  FileTree,
  Hunk,
  Refs,
  RepoInfo,
  RepoState,
  SideInfo,
  Upstream,
  Worktree,
} from "../shared/types";
import { tildify } from "./launch";
import { parseDiff, sortFiles } from "./parse";

const exec = promisify(execFile);
const MAX_BUFFER = 1024 * 1024 * 1024;
export const SIZE_LIMIT = 2 * 1024 * 1024;
const EMPTY_TREE: Record<string, string> = {
  sha1: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
  sha256: "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321",
};

// Inherited GIT_DIR/GIT_INDEX_FILE (e.g. when launched from a git hook) would point git at another repo.
const env: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"].includes(k))),
  // Stops commands that honour it from refreshing .git/index behind an agent's back; porcelain `git diff` ignores it.
  GIT_OPTIONAL_LOCKS: "0",
};

let shellPath: Promise<unknown> = Promise.resolve();

export function setShellPath(path: Promise<string | null>): void {
  shellPath = path.then((p) => {
    if (p) env.PATH = p;
  });
}

function gitArgs(root: string, args: string[]): string[] {
  // A repo's own config could otherwise make every refresh run a command.
  return ["-c", "core.quotePath=false", "-c", "core.fsmonitor=false", "--no-pager", "-C", root, ...args];
}

export async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", gitArgs(root, args), { maxBuffer: MAX_BUFFER, env });
  return stdout;
}

export async function gitBuffer(root: string, args: string[]): Promise<Buffer> {
  const { stdout } = await exec("git", gitArgs(root, args), { maxBuffer: MAX_BUFFER, env, encoding: "buffer" });
  return stdout;
}

export function gitError(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  return text.replace(/^Command failed:[^\n]*\n?/, "").trim() || text;
}

export function gitInput(root: string, args: string[], input: string | Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile("git", gitArgs(root, args), { maxBuffer: MAX_BUFFER, env }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    child.stdin!.end(input);
  });
}

export const literal = (paths: string[]) => paths.map((p) => `:(literal)${p}`);

async function tryGit(root: string, args: string[]): Promise<string | null> {
  try {
    return (await git(root, args)).trim();
  } catch {
    return null;
  }
}

const fixed = new Map<string, Promise<string | null>>();

function fixedGit(root: string, args: string[]): Promise<string | null> {
  const key = `${root}\0${args.join("\0")}`;
  let value = fixed.get(key);
  if (!value) {
    value = tryGit(root, args);
    fixed.set(key, value);
    void value.then((v) => v === null && fixed.delete(key));
  }
  return value;
}

export function missingGit(e: unknown, platform: NodeJS.Platform): string | null {
  const err = e as { code?: unknown; stderr?: unknown };
  const mac = "git isn't installed. Run xcode-select --install in a terminal, then reopen moire.";
  if (err.code === "ENOENT") return platform === "darwin" ? mac : "git isn't installed. Install it with your package manager, then reopen moire.";
  // Without the command line tools, /usr/bin/git on macOS is a stub that only offers to install them.
  return platform === "darwin" && /xcode-select|xcrun|developer tools/i.test(String(err.stderr ?? "")) ? mac : null;
}

// Stage all and rename pairing pass paths with --pathspec-from-file.
export function oldGit(version: string): string | null {
  const [major, minor] = (/(\d+)\.(\d+)/.exec(version) ?? []).slice(1).map(Number);
  return major < 2 || (major === 2 && minor < 26) ? `moire needs git 2.26 or newer, and this is ${version.trim().replace(/^git version /, "")}.` : null;
}

let missing: Promise<string | null> | undefined;

// The login shell's PATH is only waited for when git isn't on the PATH moire started with.
export function gitMissing(): Promise<string | null> {
  const version = () => exec("git", ["--version"], { env }).then(({ stdout }) => oldGit(stdout));
  missing ??= version().catch(() => shellPath.then(version).catch((e: unknown) => missingGit(e, process.platform)));
  return missing;
}

export function repoProblem(path: string, e: unknown): string {
  const text = gitError(e).replace(/^fatal: /, "");
  const where = tildify(path);
  if (/dubious ownership/i.test(text)) {
    const fix = /git config --global --add safe\.directory .+/.exec(text)?.[0];
    return `${where} belongs to another user, so git won't open it.${fix ? ` To trust it, run: ${fix}` : ""}`;
  }
  if (/permission denied/i.test(text)) return `moire can't read ${where}: permission denied`;
  if (/not a directory/i.test(text)) return `${where} isn't a folder`;
  if (/must be run in a work tree/i.test(text)) return `${where} is a bare repository, which has no files to review`;
  if (/not a git repository/i.test(text)) return `${where} isn't a git repository`;
  return text;
}

async function repoError(path: string): Promise<string> {
  const missing = await gitMissing();
  if (missing) return missing;
  if (!existsSync(path)) return `${tildify(path)} doesn't exist`;
  try {
    await git(path, ["rev-parse", "--show-toplevel"]);
    return `Couldn't open ${tildify(path)}`;
  } catch (e) {
    return repoProblem(path, e);
  }
}

export async function repoInfo(path: string): Promise<RepoInfo> {
  const root = await fixedGit(path, ["rev-parse", "--show-toplevel"]);
  if (!root) throw new Error(await repoError(path));
  const [branch, head, state] = await Promise.all([
    tryGit(root, ["symbolic-ref", "--short", "-q", "HEAD"]),
    tryGit(root, ["rev-parse", "--short", "-q", "--verify", "HEAD"]),
    repoState(root),
  ]);
  const info: RepoInfo = { root, name: basename(root), branch, head };
  if (state) info.state = state;
  return info;
}

const STATES: [string, RepoState][] = [
  ["rebase-merge", "rebasing"],
  ["rebase-apply", "rebasing"],
  ["MERGE_HEAD", "merging"],
  ["CHERRY_PICK_HEAD", "cherry-picking"],
  ["REVERT_HEAD", "reverting"],
  ["BISECT_LOG", "bisecting"],
];

async function repoState(root: string): Promise<RepoState | null> {
  const gitDir = await fixedGit(root, ["rev-parse", "--absolute-git-dir"]);
  if (!gitDir) return null;
  const found = await Promise.all(
    STATES.map(([name]) =>
      stat(join(gitDir, name)).then(
        () => true,
        () => false,
      ),
    ),
  );
  return STATES.find((_, i) => found[i])?.[1] ?? null;
}

export async function worktrees(root: string): Promise<Worktree[]> {
  const out = await tryGit(root, ["worktree", "list", "--porcelain", "-z"]);
  if (!out) return [];
  const found: { path: string; branch: string | null }[] = [];
  for (const block of out.split("\0\0")) {
    const fields = block.split("\0").filter(Boolean);
    const path = fields.find((f) => f.startsWith("worktree "))?.slice(9);
    if (!path || fields.some((f) => f === "bare" || f.startsWith("prunable"))) continue;
    const branch =
      fields
        .find((f) => f.startsWith("branch "))
        ?.slice(7)
        .replace(/^refs\/heads\//, "") ?? null;
    found.push({ path, branch });
  }
  if (found.length < 2) return [];
  return Promise.all(
    found.map(async (w) => {
      const status = await git(w.path, ["--no-optional-locks", "status", "--porcelain", "-z", "--no-renames", "--untracked-files=all"]).catch(() => "");
      return { ...w, changes: status.split("\0").filter(Boolean).length };
    }),
  );
}

export async function upstream(root: string): Promise<Upstream | null> {
  const name = await tryGit(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  if (!name) return null;
  const [counts, fetchHead] = await Promise.all([
    tryGit(root, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]),
    fixedGit(root, ["rev-parse", "--git-path", "FETCH_HEAD"]),
  ]);
  if (!counts) return null;
  const [ahead, behind] = counts.split(/\s+/).map(Number);
  const fetchedAt = fetchHead
    ? await stat(resolvePath(root, fetchHead)).then(
        (st) => st.mtimeMs,
        () => null,
      )
    : null;
  return { name, ahead, behind, fetchedAt };
}

async function resolve(root: string, rev: string): Promise<string> {
  const sha = await tryGit(root, ["rev-parse", "-q", "--verify", "--end-of-options", `${rev}^{commit}`]);
  if (!sha) throw new Error(`Unknown revision: ${rev}`);
  return sha;
}

async function emptyTree(root: string): Promise<string> {
  const format = (await fixedGit(root, ["rev-parse", "--show-object-format"])) ?? "sha1";
  return EMPTY_TREE[format] ?? EMPTY_TREE.sha1;
}

async function short(root: string, sha: string): Promise<string> {
  return (await git(root, ["rev-parse", "--short", sha])).trim();
}

const EMPTY: SideInfo = { kind: "empty", label: "Empty" };
const INDEX: SideInfo = { kind: "index", label: "Index" };
const WORKTREE: SideInfo = { kind: "worktree", label: "Working tree" };

async function headSide(root: string): Promise<SideInfo> {
  const [sha, s] = await Promise.all([
    tryGit(root, ["rev-parse", "-q", "--verify", "HEAD^{commit}"]),
    tryGit(root, ["rev-parse", "--short", "-q", "--verify", "HEAD^{commit}"]),
  ]);
  return sha && s ? { kind: "commit", rev: sha, label: `HEAD ${s}` } : EMPTY;
}

export async function sides(root: string, mode: CompareMode): Promise<{ a: SideInfo; b: SideInfo }> {
  switch (mode.kind) {
    case "unstaged":
      return { a: INDEX, b: WORKTREE };
    case "staged":
      return { a: await headSide(root), b: INDEX };
    case "all":
      return { a: await headSide(root), b: WORKTREE };
    case "commit": {
      const sha = await resolve(root, mode.sha);
      const s = await short(root, sha);
      const parent = await tryGit(root, ["rev-parse", "-q", "--verify", `${sha}^`]);
      const a: SideInfo = parent ? { kind: "commit", rev: parent, label: `${s}^` } : EMPTY;
      return { a, b: { kind: "commit", rev: sha, label: s } };
    }
    case "branches": {
      const head = await resolve(root, mode.head);
      const base = await resolve(root, mode.base);
      const mb = await tryGit(root, ["merge-base", base, head]);
      if (!mb) throw new Error(`No common ancestor between ${mode.base} and ${mode.head}`);
      return {
        a: { kind: "commit", rev: mb, label: `${mode.base} (merge base ${await short(root, mb)})` },
        b: { kind: "commit", rev: head, label: mode.head },
      };
    }
  }
}

function treeish(side: SideInfo, empty: string): string {
  return side.kind === "commit" ? side.rev! : empty;
}

export const UNTRACKED_READ_LIMIT = 1000;

interface CachedUntracked {
  size: number;
  mtimeMs: number;
  ino: number;
  file: FileDiff;
}

const untrackedCache = new Map<string, Map<string, CachedUntracked>>();

async function untracked(root: string, pathspec: string[]): Promise<FileDiff[]> {
  const out = await git(root, ["ls-files", "--others", "--exclude-standard", "-z", "--", ...pathspec]);
  const paths = out.split("\0").filter((p) => p && !p.endsWith("/"));
  const cache = untrackedCache.get(root) ?? new Map<string, CachedUntracked>();
  untrackedCache.set(root, cache);
  if (!pathspec.length) {
    const listed = new Set(paths);
    for (const p of cache.keys()) if (!listed.has(p)) cache.delete(p);
  }
  const files = await Promise.all(
    paths.map((p, i): Promise<FileDiff | null> | FileDiff =>
      i < UNTRACKED_READ_LIMIT
        ? untrackedFile(root, p, cache)
        : { path: p, status: "untracked", binary: false, tooLarge: true, unread: true, additions: 0, deletions: 0, hunks: [] },
    ),
  );
  return files.filter((f): f is FileDiff => f !== null);
}

// The diff() marks only set top-level fields on untracked files, so a shallow copy keeps the cache intact.
async function untrackedFile(root: string, path: string, cache: Map<string, CachedUntracked>): Promise<FileDiff | null> {
  const st = await lstat(join(root, path)).catch(() => null);
  const hit = st && cache.get(path);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs && hit.ino === st.ino) return { ...hit.file };
  const file = await readUntracked(root, path);
  if (file && st) {
    if (file.binary) file.blobs = `${st.size}:${st.mtimeMs}`;
    if (st.isSymbolicLink()) file.newMode = "120000";
    else if (st.mode & 0o111) file.newMode = "100755";
    cache.set(path, { size: st.size, mtimeMs: st.mtimeMs, ino: st.ino, file });
  } else {
    cache.delete(path);
  }
  return file && { ...file };
}

async function readUntracked(root: string, path: string): Promise<FileDiff | null> {
  const buf = await readWorktree(root, path);
  if (buf === null) return null;
  const file: FileDiff = { path, status: "untracked", binary: false, additions: 0, deletions: 0, hunks: [] };
  if (isBinary(buf)) file.binary = true;
  if (buf.length > SIZE_LIMIT) file.tooLarge = true;
  if (file.binary || file.tooLarge || buf.length === 0) return file;
  const text = buf.toString("utf8");
  const lines = text.split("\n");
  const noNewline = !text.endsWith("\n");
  if (!noNewline) lines.pop();
  file.additions = lines.length;
  file.hunks.push({
    oldStart: 0,
    oldLines: 0,
    newStart: 1,
    newLines: lines.length,
    header: "",
    lines: lines.map((t, i) => ({ kind: "add", text: t, newNo: i + 1 })),
  });
  if (noNewline) file.hunks[0].lines[lines.length - 1].noNewline = true;
  return file;
}

const DIFF = ["--no-color", "--no-ext-diff", "--no-textconv", "--no-relative", "-M", "--src-prefix=a/", "--dst-prefix=b/"];

// Porcelain `git diff` rewrites .git/index to refresh stat info, which can fail an agent's commit on index.lock; plumbing never writes it.
async function diffCommand(root: string, from: string | null, to: "index" | "worktree" | string): Promise<string[]> {
  const algorithm = await fixedGit(root, ["config", "--get", "--default=", "diff.algorithm"]);
  const opts = algorithm ? [...DIFF, `--diff-algorithm=${algorithm}`] : DIFF;
  if (from === null) return ["diff-files", ...opts, "--cc"];
  if (to === "worktree") return ["diff-index", ...opts, from];
  if (to === "index") return ["diff-index", ...opts, "--cached", "--ita-invisible-in-index", from];
  return ["diff", ...opts, from, to];
}

export async function diff(root: string, mode: CompareMode, paths: string[] = []): Promise<DiffResult> {
  const [repo, { a, b }, empty] = await Promise.all([repoInfo(root), sides(root, mode), emptyTree(root)]);
  const pathspec = literal(paths);
  const from = mode.kind === "unstaged" ? null : treeish(a, empty);
  const to = mode.kind === "unstaged" || mode.kind === "all" ? "worktree" : mode.kind === "staged" ? "index" : treeish(b, empty);
  const args = [...(await diffCommand(repo.root, from, to)), "-U3", "--", ...pathspec];
  const worktree = mode.kind === "unstaged" || mode.kind === "all";
  const [out, extra] = await Promise.all([git(repo.root, args), worktree ? untracked(repo.root, pathspec) : []]);
  const files = await pairRenames(repo.root, mode.kind === "all" ? treeish(a, empty) : null, parseDiff(out), extra);
  const [progress] = await Promise.all([
    worktree && !paths.length ? markChangedSinceStaged(repo.root, files, mode.kind === "unstaged", repo.head ?? empty) : undefined,
    mode.kind === "all" && markStaged(repo.root, files, treeish(a, empty), pathspec),
    markNoise(repo.root, files),
  ]);
  for (const f of files) f.version = fileVersion(f);
  const version = hash(JSON.stringify([repo, a, b, progress, files.map((f) => f.version)]));
  return { repo, a, b, files: sortFiles(files), progress, version };
}

// `mv old new` plus an edit shows as a deletion and an untracked file. Git pairs them once the new
// file is in an index as intent-to-add, so this builds a scratch index of just those paths.
async function pairRenames(root: string, base: string | null, files: FileDiff[], extra: FileDiff[]): Promise<FileDiff[]> {
  const gone = files.filter((f) => f.status === "deleted").map((f) => f.path);
  const fresh = extra.filter((f) => !f.unread).map((f) => f.path);
  if (!gone.length || !fresh.length) return [...files, ...extra];
  const index = join(tmpdir(), `moire-index-${randomUUID()}`);
  const scratch = (args: string[], input = "") =>
    new Promise<string>((resolve, reject) => {
      const opts = { maxBuffer: MAX_BUFFER, env: { ...env, GIT_INDEX_FILE: index, GIT_LITERAL_PATHSPECS: "1" } };
      const child = execFile("git", gitArgs(root, args), opts, (err, stdout) => (err ? reject(err) : resolve(stdout)));
      child.stdin!.end(input);
    });
  try {
    const entries = await git(root, ["ls-files", "-s", "-z", "--", ...literal(gone)]);
    await scratch(["update-index", "-z", "--index-info"], entries);
    await scratch(["add", "-N", "--pathspec-from-file=-", "--pathspec-file-nul"], fresh.map((p) => `${p}\0`).join(""));
    const out = await scratch(["diff", ...DIFF, "-U3", ...(base ? [base] : []), "--", ...gone, ...fresh]);
    const [wasGone, isFresh] = [new Set(gone), new Set(fresh)];
    const renames = parseDiff(out).filter((f) => f.status === "renamed" && wasGone.has(f.oldPath!) && isFresh.has(f.path));
    if (!renames.length) return [...files, ...extra];
    const paired = new Set(renames.flatMap((f) => [f.path, f.oldPath!]));
    return [...files.filter((f) => !paired.has(f.path)), ...extra.filter((f) => !paired.has(f.path)), ...renames];
  } catch {
    return [...files, ...extra];
  } finally {
    await rm(index, { force: true });
  }
}

const hash = (text: string) => createHash("sha1").update(text).digest("base64url");
const hunkVersions = new WeakMap<Hunk[], string>();

// Cached untracked files share their hunks across refreshes, so their hash is computed once.
function fileVersion(file: FileDiff): string {
  let hunks = hunkVersions.get(file.hunks);
  if (!hunks) hunkVersions.set(file.hunks, (hunks = hash(JSON.stringify(file.hunks))));
  return hash(JSON.stringify({ ...file, hunks }));
}

function rawBlobs(out: string): Map<string, string> {
  const parts = out.split("\0");
  const blobs = new Map<string, string>();
  for (let i = 0; i + 1 < parts.length;) {
    const [, , , blob, status] = parts[i].split(" ");
    const paths = /^[RC]/.test(status) ? 2 : 1;
    blobs.set(parts[i + paths], blob);
    i += paths + 1;
  }
  return blobs;
}

// Remembers fully staged blobs, to tell a later edit apart from staging part of a file.
async function markChangedSinceStaged(root: string, files: FileDiff[], filesAreUnstaged: boolean, head: string) {
  const [cached, unstaged, memoryPath] = await Promise.all([
    git(root, ["diff-index", "--cached", "--ita-invisible-in-index", "--raw", "--no-abbrev", "-z", "-M", head]),
    // --numstat compares contents, so files whose stat info alone is stale don't count.
    filesAreUnstaged ? "" : git(root, ["diff-files", "--numstat", "-z", "--no-renames"]),
    fixedGit(root, ["rev-parse", "--git-path", "moire-staged"]),
  ]);
  const numstatPaths = unstaged
    .split("\0")
    .filter(Boolean)
    .map((rec) => rec.replace(/^[^\t]*\t[^\t]*\t/, ""));
  const dirty = new Set([...numstatPaths, ...files.filter((f) => filesAreUnstaged || f.status === "untracked").map((f) => f.path)]);
  const memory = resolvePath(root, memoryPath!.trim());
  const before: Record<string, string> = await readFile(memory, "utf8")
    .then(JSON.parse)
    .catch(() => ({}));
  const after: Record<string, string> = {};
  const changed = new Set<string>();
  const staged = rawBlobs(cached);
  for (const [path, blob] of staged) {
    if (!dirty.has(path) || before[path] === blob) after[path] = blob;
    if (dirty.has(path) && before[path] === blob) changed.add(path);
  }
  if (JSON.stringify(after) !== JSON.stringify(before)) {
    const tmp = `${memory}.${randomUUID()}`;
    await writeFile(tmp, JSON.stringify(after))
      .then(() => rename(tmp, memory))
      .catch(() => rm(tmp, { force: true }));
  }
  for (const f of files) if (changed.has(f.path)) f.changedSinceStaged = true;
  return { staged: [...staged.keys()].filter((p) => !dirty.has(p)).length, total: new Set([...staged.keys(), ...dirty]).size };
}

const LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "Gemfile.lock",
  "poetry.lock",
  "uv.lock",
  "Pipfile.lock",
  "composer.lock",
  "go.sum",
  "flake.lock",
  "mix.lock",
  "pubspec.lock",
  "Podfile.lock",
  "packages.lock.json",
  "gradle.lockfile",
]);

// A one-line bundle soft-wraps into thousands of rows; ordinary code averages well under this.
const LONG_LINES = 1000;

function longLines(file: FileDiff): boolean {
  let chars = 0;
  let count = 0;
  for (const h of file.hunks) {
    for (const l of h.lines) {
      if (l.kind === "ctx") continue;
      chars += l.text.length;
      count++;
    }
  }
  return chars > 20 * LONG_LINES && chars / count > LONG_LINES;
}

function changedChars(file: FileDiff): number {
  let chars = 0;
  for (const h of file.hunks) for (const l of h.lines) chars += l.text.length + 1;
  return chars;
}

async function markNoise(root: string, files: FileDiff[]) {
  if (!files.length) return;
  for (const f of files) {
    if (f.tooLarge || changedChars(f) <= SIZE_LIMIT) continue;
    f.tooLarge = true;
    f.hunks = [];
  }
  const out = await gitInput(root, ["check-attr", "-z", "--stdin", "linguist-generated"], files.map((f) => `${f.path}\0`).join(""));
  const attr = new Map<string, string>();
  const parts = out.split("\0");
  for (let i = 0; i + 2 < parts.length; i += 3) attr.set(parts[i], parts[i + 2]);
  for (const f of files) {
    const value = attr.get(f.path);
    if (value === "false" || value === "unset") continue;
    const name = basename(f.path);
    const noise =
      value === "set" || value === "true"
        ? "Generated file"
        : LOCKFILES.has(name)
          ? "Lockfile"
          : /\.(js|mjs|cjs|css)\.map$/.test(name)
            ? "Source map"
            : /\.min\.(js|mjs|cjs|css)$/.test(name) || longLines(f)
              ? "Minified file"
              : null;
    if (noise) f.noise = noise;
  }
}

async function markStaged(root: string, files: FileDiff[], head: string, pathspec: string[]) {
  const [staged, unstaged] = await Promise.all([
    diffCommand(root, head, "index").then((cmd) => git(root, [...cmd, "-U0", "--", ...pathspec])),
    diffCommand(root, null, "worktree").then((cmd) => git(root, [...cmd, "-U0", "--", ...pathspec])),
  ]).then((out) => out.map((text) => new Map(parseDiff(text).map((f) => [f.path, f]))));
  for (const file of files) {
    const s = staged.get(file.path);
    const u = unstaged.get(file.path);
    file.staged = !s ? "none" : u ? "partial" : "full";
    if (!s) continue;
    const deleted = new Set(s.hunks.flatMap((h) => h.lines.filter((l) => l.kind === "del").map((l) => l.oldNo!)));
    const added = new Set(s.hunks.flatMap((h) => h.lines.filter((l) => l.kind === "add").map((l) => l.newNo!)));
    const toIndex = newToOld(u?.hunks ?? []);
    for (const line of file.hunks.flatMap((h) => h.lines)) {
      if (line.kind === "del" && deleted.has(line.oldNo!)) line.staged = true;
      if (line.kind === "add" && added.has(toIndex(line.newNo!) ?? -1)) line.staged = true;
    }
  }
}

export function newToOld(hunks: Hunk[]): (n: number) => number | null {
  return (n) => {
    let delta = 0;
    for (const h of hunks) {
      const first = h.newLines === 0 ? h.newStart + 1 : h.newStart;
      if (n < first) break;
      if (n < first + h.newLines) {
        const line = h.lines.find((l) => l.newNo === n);
        return line?.kind === "ctx" ? line.oldNo! : null;
      }
      delta = (h.oldLines === 0 ? h.oldStart + 1 : h.oldStart) + h.oldLines - first - h.newLines;
    }
    return n + delta;
  };
}

async function readWorktree(root: string, path: string, limit = SIZE_LIMIT): Promise<Buffer | null> {
  const full = join(root, path);
  try {
    const st = await lstat(full);
    if (st.isSymbolicLink()) return Buffer.from(await readlink(full), "utf8");
    if (!st.isFile()) return null;
    if (st.size <= limit) return await readFile(full);
    const fh = await open(full);
    try {
      const buf = Buffer.alloc(limit + 1);
      return buf.subarray(0, (await fh.read(buf, 0, buf.length, 0)).bytesRead);
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

async function readSide(root: string, side: SideInfo, path: string, limit = SIZE_LIMIT): Promise<Buffer | null> {
  try {
    if (side.kind === "worktree") return await readWorktree(root, path, limit);
    if (side.kind === "index") return await gitBuffer(root, ["cat-file", "blob", `:${path}`]);
    if (side.kind === "commit") return await gitBuffer(root, ["cat-file", "blob", `${side.rev}:${path}`]);
    return null;
  } catch {
    return null;
  }
}

export async function readBlob(root: string, side: SideInfo, path: string, limit: number): Promise<Buffer | null> {
  if (!path || isAbsolute(path) || path.split("/").includes("..")) return null;
  const buf = await readSide(root, side, path, limit);
  return buf && buf.length <= limit ? buf : null;
}

export async function blobSizes(root: string, mode: CompareMode, file: FileRef): Promise<[number | null, number | null]> {
  const { a, b } = await sides(root, mode);
  const size = async (side: SideInfo, path: string | null) => {
    if (path === null || side.kind === "empty") return null;
    if (side.kind === "worktree")
      return lstat(join(root, path))
        .then((st) => st.size)
        .catch(() => null);
    return tryGit(root, ["cat-file", "-s", side.kind === "index" ? `:${path}` : `${side.rev}:${path}`]).then((out) => (out ? Number(out) : null));
  };
  const [pathA, pathB] = sidePaths(file);
  return Promise.all([size(a, pathA), size(b, pathB)]);
}

function isBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8000).includes(0);
}

type FileRef = Pick<FileDiff, "path" | "oldPath" | "status">;

function toContents(bufA: Buffer | null, bufB: Buffer | null): FileContents {
  for (const buf of [bufA, bufB]) {
    if (buf && (buf.length > SIZE_LIMIT || isBinary(buf))) return { a: null, b: null, tooLarge: true };
  }
  return { a: bufA?.toString("utf8") ?? null, b: bufB?.toString("utf8") ?? null, tooLarge: false };
}

function sidePaths(file: FileRef): [string | null, string | null] {
  const isNew = file.status === "added" || file.status === "untracked" || file.status === "unchanged";
  return [isNew ? null : (file.oldPath ?? file.path), file.status === "deleted" ? null : file.path];
}

export async function fileContents(root: string, mode: CompareMode, file: FileRef): Promise<FileContents> {
  const { a, b } = await sides(root, mode);
  const [pathA, pathB] = sidePaths(file);
  const [bufA, bufB] = await Promise.all([pathA === null ? null : readSide(root, a, pathA), pathB === null ? null : readSide(root, b, pathB)]);
  return toContents(bufA, bufB);
}

export async function manyContents(root: string, mode: CompareMode, files: FileRef[]): Promise<FileContents[]> {
  const { a, b } = await sides(root, mode);
  const spec = (side: SideInfo, path: string | null) =>
    path === null || path.includes("\n") || side.kind === "worktree" || side.kind === "empty"
      ? null
      : side.kind === "index"
        ? `:${path}`
        : `${side.rev}:${path}`;
  const wanted = files.flatMap((f) => {
    const [pathA, pathB] = sidePaths(f);
    return [spec(a, pathA), spec(b, pathB)];
  });
  const blobs = await readBlobs(
    root,
    wanted.filter((w): w is string => w !== null),
  );
  let next = 0;
  const fromGit = wanted.map((w) => (w === null ? null : blobs[next++]));
  return Promise.all(
    files.map(async (f, i) => {
      const [pathA, pathB] = sidePaths(f);
      const read = (side: SideInfo, path: string | null, blob: Buffer | null) => (path !== null && side.kind === "worktree" ? readWorktree(root, path) : blob);
      return toContents(await read(a, pathA, fromGit[2 * i]), await read(b, pathB, fromGit[2 * i + 1]));
    }),
  );
}

function readBlobs(root: string, specs: string[]): Promise<(Buffer | null)[]> {
  if (!specs.length) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    const child = spawn("git", gitArgs(root, ["cat-file", "--batch"]), { env });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`git cat-file exited with code ${code}`));
      const out = Buffer.concat(chunks);
      const result: (Buffer | null)[] = [];
      let pos = 0;
      for (let i = 0; i < specs.length; i++) {
        const nl = out.indexOf(10, pos);
        // "<sha> <type> <size>", or "<spec> missing" where the spec is a path that may hold spaces
        const words = out.subarray(pos, nl).toString("utf8").split(" ");
        const status = words.at(-1);
        const [, type, size] = words;
        pos = nl + 1;
        if (status === "missing" || status === "ambiguous" || size === undefined) {
          result.push(null);
          continue;
        }
        result.push(type === "blob" ? out.subarray(pos, pos + Number(size)) : null);
        pos += Number(size) + 1;
      }
      resolve(result);
    });
    child.stdin.end(specs.map((s) => `${s}\n`).join(""));
  });
}

export async function tree(root: string, mode: CompareMode): Promise<FileTree> {
  const { b } = await sides(root, mode);
  const list = async (args: string[]) => (await git(root, args)).split("\0").filter(Boolean);
  if (b.kind === "commit") return { files: await list(["ls-tree", "-r", "-z", "--name-only", "--full-tree", b.rev!]), ignored: [] };
  if (b.kind === "index") return { files: [...new Set(await list(["ls-files", "--cached", "-z"]))], ignored: [] };
  const [files, ignored] = await Promise.all([
    list(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]),
    list(["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "--no-empty-directory", "-z"]),
  ]);
  return { files: [...new Set(files.filter((p) => !p.endsWith("/")))], ignored };
}

export async function listDir(root: string, dir: string): Promise<string[]> {
  if (!dir.endsWith("/") || isAbsolute(dir) || dir.split("/").includes("..")) return [];
  const entries = await readdir(join(root, dir), { withFileTypes: true });
  return entries.map((e) => `${dir}${e.name}${e.isDirectory() ? "/" : ""}`);
}

export async function commits(root: string, limit: number): Promise<CommitInfo[]> {
  if (!(await tryGit(root, ["rev-parse", "-q", "--verify", "HEAD"]))) return [];
  const n = Math.max(1, Math.floor(limit));
  const out = await git(root, ["log", "-z", `-n${n}`, "--format=%H%x1f%h%x1f%s%x1f%an%x1f%aI", "HEAD", "--"]);
  return out
    .split("\0")
    .filter(Boolean)
    .map((rec) => {
      const [sha, short, subject, author, date] = rec.split("\x1f");
      return { sha, short, subject, author, date };
    });
}

export async function commitDetail(root: string, rev: string): Promise<CommitDetail> {
  const sha = await resolve(root, rev);
  const out = await git(root, ["log", "-1", "--format=%H%x1f%h%x1f%s%x1f%an%x1f%aI%x1f%b", sha, "--"]);
  const [full, short, subject, author, date, body] = out.split("\x1f");
  return { sha: full, short, subject, author, date, body: body.trim() };
}

export async function branches(root: string): Promise<Refs> {
  const list = async (args: string[]) => (await git(root, ["for-each-ref", "--format=%(refname)", ...args])).split("\n").filter(Boolean);
  const [heads, remotes, tags, current, upstream] = await Promise.all([
    list(["refs/heads/"]),
    list(["refs/remotes/"]),
    list(["--sort=-creatordate", "refs/tags/"]),
    tryGit(root, ["symbolic-ref", "--short", "-q", "HEAD"]),
    tryGit(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]),
  ]);
  const names = heads.map((r) => r.slice("refs/heads/".length));
  return {
    current: current && names.includes(current) ? current : null,
    upstream,
    branches: current && names.includes(current) ? [current, ...names.filter((n) => n !== current)] : names,
    remotes: remotes.map((r) => r.slice("refs/remotes/".length)).filter((n) => !n.endsWith("/HEAD")),
    tags: tags.map((r) => r.slice("refs/tags/".length)),
  };
}
