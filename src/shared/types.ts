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
  oldMode?: string;
  newMode?: string;
  binary: boolean;
  blobs?: string;
  tooLarge?: boolean;
  unread?: boolean;
  staged?: "full" | "partial" | "none";
  changedSinceStaged?: boolean;
  alreadyStaged?: { stagedRanges: [number, number][]; deletionsAfter: number[] };
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
  progress?: { stagedFiles: number; totalFiles: number; lines: { staged: number; total: number } };
  version: string;
}

export interface FileTree {
  files: string[];
  ignored: string[];
}

export interface FileContents {
  a: string | null;
  b: string | null;
  hidden: boolean;
  binary?: boolean;
}

export interface BlobSize {
  bytes: number;
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
  undoId?: string;
}

export interface StageAllRequest {
  mode: "unstaged" | "staged";
  files: FileDiff[];
}

export type UndoResult = { label: string; id: string } | { refused: string; id: string; saveAs: string };

export interface UpdateNotice {
  version: string;
  manualReason?: string;
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
  skippedGitDirs: number;
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
  lines?: [number, number];
  code?: string;
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

export type Placement = { start: number; end: number } | "lost" | "all";

export interface NotesFile {
  path: string;
  notes: AgentNotes | null;
  problem?: string;
  placed?: Placement[][];
}
