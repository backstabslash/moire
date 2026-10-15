export type CompareMode =
  { kind: "unstaged" } | { kind: "staged" } | { kind: "all" } | { kind: "commit"; sha: string } | { kind: "branches"; base: string; head: string };

export interface SideInfo {
  kind: "commit" | "index" | "worktree" | "empty";
  rev?: string;
  label: string;
}

export interface RepoInfo {
  root: string;
  name: string;
  branch: string | null;
  head: string | null;
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
}

export interface DiffResult {
  repo: RepoInfo;
  a: SideInfo;
  b: SideInfo;
  files: FileDiff[];
  progress?: { staged: number; total: number };
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

export interface CommitInfo {
  sha: string;
  short: string;
  subject: string;
  author: string;
  date: string;
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
