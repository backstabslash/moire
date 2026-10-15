import { type FSWatcher, watch } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { git, gitInput } from "./git";

const QUIET_MS = 150;
const MAX_WAIT_MS = 1000;
const GIT_STATE = new Set(["index", "HEAD", "packed-refs", "FETCH_HEAD", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"]);
// Linux has no cheap recursive watch: it would add a watch per directory, ignored ones included.
const RECURSIVE = process.platform === "darwin" || process.platform === "win32";

export class RepoWatcher {
  private watchers = new Map<string, FSWatcher>();
  private gitDirs = new Set<string>();
  private remotes = "";
  // Directories with no files yet, which ls-files can't report.
  private adopted = new Set<string>();
  private adopting = new Set<Promise<void>>();
  private pending = new Set<string>();
  private gitTouched = false;
  private quiet: NodeJS.Timeout | null = null;
  private maxWait: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(
    readonly root: string,
    private onChange: () => void,
  ) {}

  async start(): Promise<void> {
    const [gitDir, commonDir] = await Promise.all([git(this.root, ["rev-parse", "--absolute-git-dir"]), git(this.root, ["rev-parse", "--git-common-dir"])]);
    const common = resolve(this.root, commonDir.trim());
    this.gitDirs = new Set([gitDir.trim(), common, join(common, "refs"), join(common, "refs", "heads")]);
    this.remotes = join(common, "refs", "remotes");
    await this.sync();
    if (RECURSIVE) return;
    const empty = await git(this.root, ["ls-files", "--others", "--exclude-standard", "--directory", "-z"]);
    await this.adopt(empty.split("\0").flatMap((p) => (p.endsWith("/") ? [join(this.root, p.slice(0, -1))] : [])));
  }

  close(): void {
    this.closed = true;
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
    if (this.quiet) clearTimeout(this.quiet);
    if (this.maxWait) clearTimeout(this.maxWait);
  }

  private async sync() {
    const dirs = new Set(this.gitDirs);
    const remotes = await readdir(this.remotes, { withFileTypes: true }).catch(() => null);
    if (remotes) dirs.add(this.remotes);
    for (const r of remotes ?? []) if (r.isDirectory()) dirs.add(join(this.remotes, r.name));
    if (RECURSIVE) {
      dirs.add(this.root);
    } else {
      const [tracked, untracked] = await Promise.all([
        git(this.root, ["ls-files", "-z"]),
        git(this.root, ["ls-files", "--others", "--exclude-standard", "-z"]),
      ]);
      dirs.add(this.root);
      for (const path of `${tracked}\0${untracked}`.split("\0")) {
        for (let dir = dirname(path); path && dir !== "." && !dirs.has(join(this.root, dir)); dir = dirname(dir)) dirs.add(join(this.root, dir));
      }
      const adopted = [...this.adopted];
      const gone = await Promise.all(
        adopted.map((d) =>
          lstat(d).then(
            (st) => !st.isDirectory(),
            () => true,
          ),
        ),
      );
      adopted.forEach((d, i) => (gone[i] ? this.adopted.delete(d) : dirs.add(d)));
    }
    if (this.closed) return;
    for (const [dir, w] of this.watchers) {
      if (dirs.has(dir) || this.adopted.has(dir)) continue;
      w.close();
      this.watchers.delete(dir);
    }
    for (const dir of dirs) this.watchDir(dir);
  }

  private watchDir(dir: string) {
    if (this.watchers.has(dir)) return;
    try {
      const recursive = RECURSIVE && dir === this.root;
      const w = watch(dir, { recursive }, (_event, name) => this.event(dir, name?.toString() ?? null));
      w.on("error", () => {
        w.close();
        this.watchers.delete(dir);
      });
      this.watchers.set(dir, w);
    } catch {
      // gone already, or out of inotify watches; the next sync tries again
    }
  }

  // Watches new directories level by level, so files written into them right away are still seen.
  private async adopt(paths: string[]) {
    for (let level = paths; level.length && !this.closed;) {
      const found = await Promise.all(
        level.map((p) =>
          lstat(p).then(
            (st) => (st.isDirectory() && basename(p) !== ".git" && !this.watchers.has(p) ? p : null),
            () => null,
          ),
        ),
      );
      const dirs = found.filter((d): d is string => d !== null);
      const ignored = await ignoredPaths(
        this.root,
        dirs.map((d) => relative(this.root, d)),
      );
      const kept = dirs.filter((d) => !ignored.has(relative(this.root, d)));
      if (this.closed) return;
      for (const dir of kept) {
        this.adopted.add(dir);
        this.watchDir(dir);
      }
      const children = await Promise.all(
        kept.map((d) =>
          readdir(d, { withFileTypes: true }).then(
            (entries) => entries.filter((e) => e.isDirectory()).map((e) => join(d, e.name)),
            () => [],
          ),
        ),
      );
      level = children.flat();
    }
  }

  private event(dir: string, name: string | null) {
    const full = name ? join(dir, name) : dir;
    const inGit = [...this.gitDirs].find((g) => full === g || full.startsWith(g + sep));
    if (inGit) {
      const rel = relative(inGit, full);
      const refs =
        dir === join(inGit, "refs") || ["heads", "remotes"].some((kind) => dir === join(inGit, "refs", kind) || rel.startsWith(join("refs", kind) + sep));
      const state = GIT_STATE.has(rel) || refs;
      if (!state) return;
      this.gitTouched = true;
    } else {
      const rel = relative(this.root, full);
      if (!RECURSIVE && name && !this.pending.has(rel) && !this.watchers.has(full)) {
        const adopting = this.adopt([full]).catch(() => {});
        this.adopting.add(adopting);
        void adopting.then(() => this.adopting.delete(adopting));
      }
      this.pending.add(rel);
    }
    if (this.quiet) clearTimeout(this.quiet);
    this.quiet = setTimeout(() => void this.flush(), QUIET_MS);
    this.maxWait ??= setTimeout(() => void this.flush(), MAX_WAIT_MS);
  }

  private async flush() {
    if (this.quiet) clearTimeout(this.quiet);
    if (this.maxWait) clearTimeout(this.maxWait);
    this.quiet = this.maxWait = null;
    const paths = [...this.pending];
    const gitTouched = this.gitTouched;
    this.pending.clear();
    this.gitTouched = false;
    await Promise.all(this.adopting);
    if (!gitTouched && (await allIgnored(this.root, paths))) return;
    if (this.closed) return;
    this.onChange();
    await this.sync().catch(() => {});
  }
}

async function allIgnored(root: string, paths: string[]): Promise<boolean> {
  if (!paths.length) return true;
  return (await ignoredPaths(root, paths)).size === new Set(paths).size;
}

async function ignoredPaths(root: string, paths: string[]): Promise<Set<string>> {
  if (!paths.length) return new Set();
  try {
    const out = await gitInput(root, ["check-ignore", "-z", "--stdin"], paths.join("\0") + "\0");
    return new Set(out.split("\0").filter(Boolean));
  } catch {
    // exit code 1 means none of them are ignored
    return new Set();
  }
}
