export type CompareMode =
  | { kind: "unstaged" }
  | { kind: "staged" }
  | { kind: "all" }
  | { kind: "commit"; sha: string }
  | { kind: "branches"; base: string; head: string };

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

export type FileStatus = "added" | "modified" | "deleted" | "renamed" | "untracked" | "conflicted";

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
  // for binary files, the blob ids or file stamp of each side, so a rewrite changes the file's key
  blobs?: string;
  tooLarge?: boolean;
  // an untracked file past the read limit, so its contents weren't loaded (tooLarge is set too)
  unread?: boolean;
  staged?: "full" | "partial" | "none";
  // why the file is folded away by default: "Lockfile", "Snapshot" or "Generated file"
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

// A changed line, by its index in hunk.lines.
export interface LineRef {
  hunk: number;
  line: number;
}

export interface StageRequest {
  mode: "unstaged" | "staged";
  action: StageAction;
  // The file's diff as the user saw it; the action is refused if it no longer matches.
  file: FileDiff;
  lines: LineRef[] | null;
}
