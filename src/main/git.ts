import { execFile, spawn } from "node:child_process";
import { lstat, open, readdir, readFile, readlink } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type { CommitInfo, CompareMode, DiffResult, FileContents, FileDiff, FileTree, Hunk, RepoInfo, SideInfo } from "../shared/types";
import { parseDiff, sortFiles } from "./parse";

const exec = promisify(execFile);
const MAX_BUFFER = 1024 * 1024 * 1024;
export const SIZE_LIMIT = 2 * 1024 * 1024;
const EMPTY_TREE: Record<string, string> = {
  sha1: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
  sha256: "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321",
};

// Inherited GIT_DIR/GIT_INDEX_FILE (e.g. when launched from a git hook) would point git at another repo.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"].includes(k)));

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

export async function repoInfo(path: string): Promise<RepoInfo> {
  const root = await tryGit(path, ["rev-parse", "--show-toplevel"]);
  if (!root) throw new Error(`Not a git repository: ${path}`);
  return {
    root,
    name: basename(root),
    branch: await tryGit(root, ["symbolic-ref", "--short", "-q", "HEAD"]),
    head: await tryGit(root, ["rev-parse", "--short", "-q", "--verify", "HEAD"]),
  };
}

async function resolve(root: string, rev: string): Promise<string> {
  const sha = await tryGit(root, ["rev-parse", "-q", "--verify", "--end-of-options", `${rev}^{commit}`]);
  if (!sha) throw new Error(`Unknown revision: ${rev}`);
  return sha;
}

async function emptyTree(root: string): Promise<string> {
  const format = (await tryGit(root, ["rev-parse", "--show-object-format"])) ?? "sha1";
  return EMPTY_TREE[format] ?? EMPTY_TREE.sha1;
}

async function short(root: string, sha: string): Promise<string> {
  return (await git(root, ["rev-parse", "--short", sha])).trim();
}

const EMPTY: SideInfo = { kind: "empty", label: "Empty" };
const INDEX: SideInfo = { kind: "index", label: "Index" };
const WORKTREE: SideInfo = { kind: "worktree", label: "Working tree" };

async function headSide(root: string): Promise<SideInfo> {
  const sha = await tryGit(root, ["rev-parse", "-q", "--verify", "HEAD^{commit}"]);
  return sha ? { kind: "commit", rev: sha, label: `HEAD ${await short(root, sha)}` } : EMPTY;
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

async function untracked(root: string, pathspec: string[]): Promise<FileDiff[]> {
  const out = await git(root, ["ls-files", "--others", "--exclude-standard", "-z", "--", ...pathspec]);
  const paths = out.split("\0").filter((p) => p && !p.endsWith("/"));
  const files = await Promise.all(
    paths.map((p, i): Promise<FileDiff | null> | FileDiff =>
      i < UNTRACKED_READ_LIMIT
        ? untrackedFile(root, p)
        : { path: p, status: "untracked", binary: false, tooLarge: true, unread: true, additions: 0, deletions: 0, hunks: [] },
    ),
  );
  return files.filter((f): f is FileDiff => f !== null);
}

async function untrackedFile(root: string, path: string): Promise<FileDiff | null> {
  const buf = await readWorktree(root, path);
  if (buf === null) return null;
  const file: FileDiff = { path, status: "untracked", binary: false, additions: 0, deletions: 0, hunks: [] };
  if (isBinary(buf)) file.binary = true;
  if (buf.length > SIZE_LIMIT) file.tooLarge = true;
  if (file.binary) {
    const st = await lstat(join(root, path)).catch(() => null);
    if (st) file.blobs = `${st.size}:${st.mtimeMs}`;
  }
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

const DIFF = ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-relative", "-M", "--src-prefix=a/", "--dst-prefix=b/"];

export async function diff(root: string, mode: CompareMode, paths: string[] = []): Promise<DiffResult> {
  const repo = await repoInfo(root);
  const { a, b } = await sides(repo.root, mode);
  const empty = await emptyTree(repo.root);
  const pathspec = literal(paths);
  const args = [...DIFF, "-U3"];
  if (mode.kind === "staged") args.push("--cached", treeish(a, empty));
  else if (mode.kind === "all") args.push(treeish(a, empty));
  else if (mode.kind === "commit" || mode.kind === "branches") args.push(treeish(a, empty), treeish(b, empty));
  args.push("--", ...pathspec);
  const files = parseDiff(await git(repo.root, args));
  if (mode.kind === "unstaged" || mode.kind === "all") files.push(...(await untracked(repo.root, pathspec)));
  if (mode.kind === "all") await markStaged(repo.root, files, treeish(a, empty), pathspec);
  await markNoise(repo.root, files);
  return { repo, a, b, files: sortFiles(files) };
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

async function markNoise(root: string, files: FileDiff[]) {
  if (!files.length) return;
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
          : name.endsWith(".snap") || /(^|\/)__snapshots__\//.test(f.path)
            ? "Snapshot"
            : null;
    if (noise) f.noise = noise;
  }
}

async function markStaged(root: string, files: FileDiff[], head: string, pathspec: string[]) {
  const [staged, unstaged] = await Promise.all([
    git(root, [...DIFF, "-U0", "--cached", head, "--", ...pathspec]),
    git(root, [...DIFF, "-U0", "--", ...pathspec]),
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

export async function branches(root: string): Promise<string[]> {
  const out = await git(root, ["for-each-ref", "--format=%(refname)", "refs/heads/"]);
  const names = out
    .split("\n")
    .filter(Boolean)
    .map((r) => r.slice("refs/heads/".length));
  const current = await tryGit(root, ["symbolic-ref", "--short", "-q", "HEAD"]);
  return current && names.includes(current) ? [current, ...names.filter((n) => n !== current)] : names;
}
