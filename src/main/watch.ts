import { type FSWatcher, watch } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { git, gitInput } from "./git";

const QUIET_MS = 150;
const MAX_WAIT_MS = 1000;
const GIT_STATE = new Set(["index", "HEAD", "packed-refs"]);
// macOS and Windows have cheap native recursive watching; Linux would add a watch for every directory, ignored ones included.
const RECURSIVE = process.platform === "darwin" || process.platform === "win32";

// Calls onChange once per burst of edits in the repo, skipping bursts that only touch gitignored files.
export class RepoWatcher {
  private watchers = new Map<string, FSWatcher>();
  private gitDirs = new Set<string>();
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
    const [gitDir, commonDir] = await Promise.all([
      git(this.root, ["rev-parse", "--absolute-git-dir"]),
      git(this.root, ["rev-parse", "--git-common-dir"]),
    ]);
    const common = resolve(this.root, commonDir.trim());
    this.gitDirs = new Set([gitDir.trim(), common, join(common, "refs", "heads")]);
    await this.sync();
  }

  close(): void {
    this.closed = true;
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
    if (this.quiet) clearTimeout(this.quiet);
    if (this.maxWait) clearTimeout(this.maxWait);
  }

  // Re-run after every change so directories the agent created get watched too.
  private async sync() {
    const dirs = new Set(this.gitDirs);
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
    }
    if (this.closed) return;
    for (const [dir, w] of this.watchers) {
      if (dirs.has(dir)) continue;
      w.close();
      this.watchers.delete(dir);
    }
    for (const dir of dirs) {
      if (this.watchers.has(dir)) continue;
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
  }

  private event(dir: string, name: string | null) {
    const full = name ? join(dir, name) : dir;
    const inGit = [...this.gitDirs].find((g) => full === g || full.startsWith(g + sep));
    if (inGit) {
      const rel = relative(inGit, full);
      const state = GIT_STATE.has(rel) || dir === join(inGit, "refs", "heads") || rel.startsWith(join("refs", "heads") + sep);
      if (!state) return;
      this.gitTouched = true;
    } else {
      this.pending.add(relative(this.root, full));
    }
    if (this.quiet) clearTimeout(this.quiet);
    this.quiet = setTimeout(() => this.flush(), QUIET_MS);
    this.maxWait ??= setTimeout(() => this.flush(), MAX_WAIT_MS);
  }

  private async flush() {
    if (this.quiet) clearTimeout(this.quiet);
    if (this.maxWait) clearTimeout(this.maxWait);
    this.quiet = this.maxWait = null;
    const paths = [...this.pending];
    const gitTouched = this.gitTouched;
    this.pending.clear();
    this.gitTouched = false;
    if (!gitTouched && (await allIgnored(this.root, paths))) return;
    if (this.closed) return;
    this.onChange();
    await this.sync().catch(() => {});
  }
}

async function allIgnored(root: string, paths: string[]): Promise<boolean> {
  if (!paths.length) return true;
  try {
    const out = await gitInput(root, ["check-ignore", "-z", "--stdin"], paths.join("\0") + "\0");
    return out.split("\0").filter(Boolean).length === paths.length;
  } catch {
    // exit code 1 means none of them are ignored
    return false;
  }
}
