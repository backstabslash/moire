export type CompareMode =
  { kind: "unstaged" } | { kind: "staged" } | { kind: "all" } | { kind: "commit"; sha: string } | { kind: "branches"; base: string; head: string };

export interface SideInfo {
  kind: "commit" | "index" | "worktree" | "empty";
  rev?: string;
  label: string;
}

export type RepoState = "merging" | "rebasing" | "cherry-picking" | "reverting" | "bisecting";

export interface Worktree {
  path: string;
  branch: string | null;
  changes: number;
}

export interface Upstream {
  name: string;
  ahead: number;
  behind: number;
  fetchedAt: number | null;
}

export interface RepoInfo {
  root: string;
  name: string;
  branch: string | null;
  head: string | null;
  state?: RepoState;
}

export type FileStatus = "added" | "modified" | "deleted" | "renamed" | "untracked" | "conflicted" | "unchanged";

export interface DiffLine {
  kind: "ctx" | "add" | "del";
  text: string;
  oldNo?: number;
  newNo?: number;
  noNewline?: boolean;
  staged?: boolean;
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
  lines: DiffLine[];
}

export interface FileDiff {
  path: string;
  oldPath?: string;
  status: FileStatus;
  // Git's file modes ("100755", "120000" for symlinks, "160000" for submodules), unset when both are plain "100644".
  oldMode?: string;
  newMode?: string;
  binary: boolean;
  blobs?: string;
  tooLarge?: boolean;
  unread?: boolean;
  staged?: "full" | "partial" | "none";
  changedSinceStaged?: boolean;
  noise?: string;
  additions: number;
  deletions: number;
  hunks: Hunk[];
  version?: string;
}

export interface DiffResult {
  repo: RepoInfo;
  a: SideInfo;
  b: SideInfo;
  files: FileDiff[];
  progress?: { staged: number; total: number };
  version: string;
}

export interface FileTree {
  files: string[];
  ignored: string[];
}

export interface FileContents {
  a: string | null;
  b: string | null;
  tooLarge: boolean;
}

export interface BlobSize {
  bytes: number;
  // A Git LFS pointer whose file isn't in the local LFS store.
  lfsMissing?: boolean;
}

export interface CommitInfo {
  sha: string;
  short: string;
  subject: string;
  author: string;
  date: string;
}

export interface CommitDetail extends CommitInfo {
  body: string;
}

export interface Refs {
  current: string | null;
  upstream: string | null;
  branches: string[];
  remotes: string[];
  tags: string[];
}

export type StageAction = "stage" | "unstage" | "discard";

export interface LineRef {
  hunk: number;
  line: number;
}

export interface StageRequest {
  mode: "unstaged" | "staged";
  action: StageAction;
  file: FileDiff;
  lines: LineRef[] | null;
}

export interface StageAllRequest {
  mode: "unstaged" | "staged";
  files: FileDiff[];
}

export type UndoResult = { label: string } | { refused: string; id: string; saveAs: string };

export interface UpdateNotice {
  version: string;
  // Set when this copy can't replace itself, saying why; the button then opens the release page.
  manual?: string;
}

export interface CopyItem {
  source: string;
  dest: string;
  clash: boolean;
}

export interface CopyPlan {
  dir: string;
  sources: string[];
  items: CopyItem[];
  // Nested .git folders left out of the copy.
  skipped: number;
  ignored: boolean;
}

export type ClashChoice = "skip" | "keep" | "replace";

export interface CopyResult {
  text: string;
  copied: number;
}

export interface ClashDiff {
  file: FileDiff;
  contents: FileContents | null;
  sizes: [number, number];
}

export interface NoteRange {
  path: string;
  // First and last line in the new version; unset for all of the file's changes.
  lines?: [number, number];
  // The first line as written, so the range can follow it when lines above it change.
  code?: string;
  // A pinned note on just these lines.
  note?: string;
  warn?: boolean;
}

export interface Chapter {
  title: string;
  text: string;
  warn?: boolean;
  ranges: NoteRange[];
}

export interface AgentNotes {
  summary?: string;
  chapters: Chapter[];
}

// Where a range's lines are in the work tree now: null is all of its file's changes.
export type Placement = { start: number; end: number } | "lost" | null;

export interface NotesFile {
  path: string;
  notes: AgentNotes | null;
  problem?: string;
  placed?: Placement[][];
}
