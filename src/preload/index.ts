import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { CommandId, ResolvedKeys } from "../shared/keymap";
import type {
  BlobSize,
  ClashChoice,
  ClashDiff,
  CommitDetail,
  CommitInfo,
  CompareMode,
  CopyPlan,
  CopyResult,
  DiffResult,
  FileContents,
  FileDiff,
  FileTree,
  NotesFile,
  Refs,
  RepoInfo,
  StageAllRequest,
  StageRequest,
  UndoResult,
  UpdateNotice,
  Upstream,
  Worktree,
} from "../shared/types";

const api = {
  platform: process.platform,
  initialRepo: (): Promise<RepoInfo | null> => ipcRenderer.invoke("repo:initial"),
  openRepo: (path: string): Promise<RepoInfo> => ipcRenderer.invoke("repo:open", path),
  pickRepo: (from?: string): Promise<RepoInfo | null> => ipcRenderer.invoke("repo:pick", from),
  recentRepos: (): Promise<string[]> => ipcRenderer.invoke("repo:recent"),
  worktrees: (root: string): Promise<Worktree[]> => ipcRenderer.invoke("repo:worktrees", root),
  watch: (root: string): Promise<void> => ipcRenderer.invoke("repo:watch", root),
  watchFolders: (root: string, dirs: string[]): Promise<void> => ipcRenderer.invoke("repo:watchFolders", root, dirs),
  onRepoChanged: (listener: () => void): (() => void) => {
    const handler = () => listener();
    ipcRenderer.on("repo:changed", handler);
    return () => {
      ipcRenderer.off("repo:changed", handler);
    };
  },
  onZoom: (listener: (factor: number) => void): (() => void) => {
    const handler = (_e: unknown, factor: number) => listener(factor);
    ipcRenderer.on("zoom:changed", handler);
    return () => {
      ipcRenderer.off("zoom:changed", handler);
    };
  },
  zoom: (): Promise<number> => ipcRenderer.invoke("zoom:get"),
  resetZoom: (): Promise<void> => ipcRenderer.invoke("zoom:step", 0),
  stepZoom: (delta: -1 | 0 | 1): Promise<void> => ipcRenderer.invoke("zoom:step", delta),
  keys: (): Promise<ResolvedKeys> => ipcRenderer.invoke("keys:get"),
  editKeys: (): Promise<void> => ipcRenderer.invoke("keys:edit"),
  checkForUpdates: (): Promise<void> => ipcRenderer.invoke("app:check-updates"),
  reportIssue: (): Promise<void> => ipcRenderer.invoke("app:report-issue"),
  updateNotice: (): Promise<UpdateNotice | null> => ipcRenderer.invoke("update:get"),
  applyUpdate: (): Promise<void> => ipcRenderer.invoke("update:apply"),
  onUpdateNotice: (listener: (notice: UpdateNotice | null) => void): (() => void) => {
    const handler = (_e: unknown, notice: UpdateNotice | null) => listener(notice);
    ipcRenderer.on("update:notice", handler);
    return () => {
      ipcRenderer.off("update:notice", handler);
    };
  },
  onKeysChanged: (listener: () => void): (() => void) => {
    const handler = () => listener();
    ipcRenderer.on("keys:changed", handler);
    return () => {
      ipcRenderer.off("keys:changed", handler);
    };
  },
  onMenu: (listener: (id: CommandId, arg?: string) => void): (() => void) => {
    const handler = (_e: unknown, id: CommandId, arg?: string) => listener(id, arg);
    ipcRenderer.on("menu:command", handler);
    return () => {
      ipcRenderer.off("menu:command", handler);
    };
  },
  diff: (root: string, mode: CompareMode): Promise<DiffResult> => ipcRenderer.invoke("git:diff", root, mode),
  fileContents: (root: string, mode: CompareMode, file: Pick<FileDiff, "path" | "oldPath" | "status">): Promise<FileContents> =>
    ipcRenderer.invoke("git:file", root, mode, file),
  manyContents: (root: string, mode: CompareMode, files: Pick<FileDiff, "path" | "oldPath" | "status">[]): Promise<FileContents[]> =>
    ipcRenderer.invoke("git:files", root, mode, files),
  blobSizes: (root: string, mode: CompareMode, file: Pick<FileDiff, "path" | "oldPath" | "status">): Promise<[BlobSize | null, BlobSize | null]> =>
    ipcRenderer.invoke("git:sizes", root, mode, file),
  tree: (root: string, mode: CompareMode): Promise<FileTree> => ipcRenderer.invoke("git:tree", root, mode),
  listDir: (root: string, dir: string): Promise<string[]> => ipcRenderer.invoke("git:dir", root, dir),
  commits: (root: string, limit: number): Promise<CommitInfo[]> => ipcRenderer.invoke("git:commits", root, limit),
  commitDetail: (root: string, rev: string): Promise<CommitDetail> => ipcRenderer.invoke("git:commit-detail", root, rev),
  branches: (root: string): Promise<Refs> => ipcRenderer.invoke("git:branches", root),
  upstream: (root: string): Promise<Upstream | null> => ipcRenderer.invoke("git:upstream", root),
  act: (root: string, req: StageRequest): Promise<string> => ipcRenderer.invoke("git:act", root, req),
  actAll: (root: string, req: StageAllRequest): Promise<string> => ipcRenderer.invoke("git:act-all", root, req),
  undo: (root: string): Promise<UndoResult | null> => ipcRenderer.invoke("git:undo", root),
  saveDiscarded: (root: string, id: string): Promise<string> => ipcRenderer.invoke("git:save-discarded", root, id),
  dropDiscarded: (root: string, id: string): Promise<void> => ipcRenderer.invoke("git:drop-discarded", root, id),
  commit: (root: string, message: string): Promise<string> => ipcRenderer.invoke("git:commit", root, message),
  notes: (root: string, commit?: string): Promise<NotesFile> => ipcRenderer.invoke("notes:get", root, commit),
  openInEditor: (root: string, path: string, line: number): Promise<string> => ipcRenderer.invoke("editor:open", root, path, line),
  revealFile: (root: string, path: string): Promise<void> => ipcRenderer.invoke("file:reveal", root, path),
  openWithDefault: (root: string, path: string): Promise<void> => ipcRenderer.invoke("file:open", root, path),
  copy: (text: string): Promise<void> => ipcRenderer.invoke("clipboard:write", text),
  dragFile: (root: string, path: string): Promise<void> => ipcRenderer.invoke("file:drag", root, path),
  droppedPaths: (files: File[]): string[] =>
    files.map((file) => {
      const path = webUtils.getPathForFile(file);
      if (!path) throw new Error("Can't read this file. Try Copy files here… or paste it.");
      return path;
    }),
  planCopy: (root: string, sources: string[], dir: string): Promise<CopyPlan> => ipcRenderer.invoke("files:plan", root, sources, dir),
  copyIn: (root: string, plan: CopyPlan, decisions: Record<string, ClashChoice>): Promise<CopyResult> =>
    ipcRenderer.invoke("files:copy", root, plan, decisions),
  clashDiff: (root: string, source: string, dest: string): Promise<ClashDiff> => ipcRenderer.invoke("files:clash-diff", root, source, dest),
  clipboardFiles: (): Promise<string[]> => ipcRenderer.invoke("files:clipboard"),
  pickFiles: (): Promise<string[]> => ipcRenderer.invoke("files:pick"),
  setTheme: (frame: string, symbols: string): Promise<void> => ipcRenderer.invoke("window:theme", frame, symbols),
  devHooks: (): Promise<{ bench: boolean; screenshot: boolean; prefs: Record<string, string> | null }> => ipcRenderer.invoke("dev:hooks"),
  ready: (): Promise<void> => ipcRenderer.invoke("dev:ready"),
  benchReport: (result: string): Promise<void> => ipcRenderer.invoke("dev:bench-report", result),
};

contextBridge.exposeInMainWorld("moire", api);

export type MoireApi = typeof api;
