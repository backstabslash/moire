import { contextBridge, ipcRenderer } from "electron";
import type { CommitInfo, CompareMode, DiffResult, FileContents, FileDiff, RepoInfo, StageRequest } from "../shared/types";

const api = {
  platform: process.platform,
  initialRepo: (): Promise<RepoInfo | null> => ipcRenderer.invoke("repo:initial"),
  openRepo: (path: string): Promise<RepoInfo> => ipcRenderer.invoke("repo:open", path),
  pickRepo: (from?: string): Promise<RepoInfo | null> => ipcRenderer.invoke("repo:pick", from),
  recentRepos: (): Promise<string[]> => ipcRenderer.invoke("repo:recent"),
  watch: (root: string): Promise<void> => ipcRenderer.invoke("repo:watch", root),
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
  resetZoom: (): Promise<void> => ipcRenderer.invoke("zoom:reset"),
  diff: (root: string, mode: CompareMode): Promise<DiffResult> => ipcRenderer.invoke("git:diff", root, mode),
  fileContents: (root: string, mode: CompareMode, file: Pick<FileDiff, "path" | "oldPath" | "status">): Promise<FileContents> =>
    ipcRenderer.invoke("git:file", root, mode, file),
  manyContents: (root: string, mode: CompareMode, files: Pick<FileDiff, "path" | "oldPath" | "status">[]): Promise<FileContents[]> =>
    ipcRenderer.invoke("git:files", root, mode, files),
  blobSizes: (root: string, mode: CompareMode, file: Pick<FileDiff, "path" | "oldPath" | "status">): Promise<[number | null, number | null]> =>
    ipcRenderer.invoke("git:sizes", root, mode, file),
  commits: (root: string, limit: number): Promise<CommitInfo[]> => ipcRenderer.invoke("git:commits", root, limit),
  branches: (root: string): Promise<string[]> => ipcRenderer.invoke("git:branches", root),
  act: (root: string, req: StageRequest): Promise<string> => ipcRenderer.invoke("git:act", root, req),
  undo: (root: string): Promise<string | null> => ipcRenderer.invoke("git:undo", root),
  commit: (root: string, message: string): Promise<string> => ipcRenderer.invoke("git:commit", root, message),
  openInEditor: (root: string, path: string, line: number): Promise<string> => ipcRenderer.invoke("editor:open", root, path, line),
  copy: (text: string): Promise<void> => ipcRenderer.invoke("clipboard:write", text),
  setTheme: (frame: string, symbols: string): Promise<void> => ipcRenderer.invoke("window:theme", frame, symbols),
  devHooks: (): Promise<{ bench: boolean; screenshot: boolean; prefs: Record<string, string> | null }> => ipcRenderer.invoke("dev:hooks"),
  ready: (): Promise<void> => ipcRenderer.invoke("dev:ready"),
  benchReport: (result: string): Promise<void> => ipcRenderer.invoke("dev:bench-report", result),
};

contextBridge.exposeInMainWorld("moire", api);

export type MoireApi = typeof api;
