import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { app, BrowserWindow, clipboard, dialog, ipcMain, webContents, type WebContents } from "electron";
import type { CompareMode, FileDiff, RepoInfo, StageAllRequest, StageRequest } from "../shared/types";
import { blobSizes, branches, commitDetail, commits, diff, fileContents, gitMissing, listDir, manyContents, repoInfo, tree, upstream, worktrees } from "./git";
import { openInEditor } from "./editor";
import { editKeys, loadKeys } from "./keys";
import { buildMenu, reportIssue } from "./menu";
import { type LaunchRequest, usableCwd } from "./launch";
import { openWithDefault, revealFile } from "./open";
import { allowPreviews } from "./preview";
import { act, actAll, adoptLegacyUndo, commit, dropDiscarded, saveDiscarded, undo } from "./stage";
import { loadState, saveState } from "./state";
import { checkForUpdates } from "./update";
import { RepoWatcher } from "./watch";

const RECENT_LIMIT = 10;

async function openRepo(path: string): Promise<RepoInfo> {
  const info = await repoInfo(path);
  const recent = [info.root, ...(loadState().recent ?? []).filter((r) => r !== info.root)].slice(0, RECENT_LIMIT);
  saveState({ lastRepo: info.root, recent });
  buildMenu();
  allowPreviews(info.root);
  void adoptLegacyUndo(info.root, join(app.getPath("userData"), "undo.json")).catch(() => {});
  return info;
}

export async function launchRepo({ path, cwd }: LaunchRequest, fallback: boolean): Promise<RepoInfo | null> {
  const missing = await gitMissing();
  if (missing) throw new Error(missing);
  if (path) return openRepo(path);
  const candidates = [app.isPackaged ? usableCwd(cwd) : process.env.MOIRE_REPO, fallback ? loadState().lastRepo : undefined];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return await openRepo(candidate);
    } catch {}
  }
  return null;
}

const launches = new Map<number, Promise<RepoInfo | null>>();
const shown = new Map<number, string>();

export function showRepo(contents: WebContents, repo: Promise<RepoInfo | null>): void {
  const id = contents.id;
  launches.set(id, repo);
  void repo.then(
    (info) => {
      if (info && !shown.has(id)) shown.set(id, info.root);
    },
    () => {},
  );
  contents.once("destroyed", () => {
    launches.delete(id);
    shown.delete(id);
  });
}

export function windowShowing(root: string): BrowserWindow | null {
  for (const [id, r] of shown) {
    const contents = r === root ? webContents.fromId(id) : undefined;
    if (contents) return BrowserWindow.fromWebContents(contents);
  }
  return null;
}

async function openIn(id: number, path: string): Promise<RepoInfo> {
  const info = await openRepo(path);
  shown.set(id, info.root);
  return info;
}

const watchers = new Map<number, RepoWatcher>();

export function registerIpc(): void {
  ipcMain.handle("repo:watch", async (e, root: string) => {
    const id = e.sender.id;
    const sender = e.sender;
    if (watchers.get(id)?.root === root) return;
    if (!watchers.has(id)) {
      sender.once("destroyed", () => {
        watchers.get(id)?.close();
        watchers.delete(id);
      });
    }
    watchers.get(id)?.close();
    const watcher = new RepoWatcher(root, () => {
      if (!sender.isDestroyed()) sender.send("repo:changed");
    });
    watchers.set(id, watcher);
    await watcher.start();
  });
  ipcMain.handle("repo:initial", (e) => {
    const root = shown.get(e.sender.id);
    return root ? openRepo(root) : (launches.get(e.sender.id) ?? launchRepo({ cwd: process.cwd() }, true));
  });
  ipcMain.handle("repo:open", (e, path: string) => openIn(e.sender.id, path));
  ipcMain.handle("repo:recent", () => (loadState().recent ?? []).filter((r) => existsSync(join(r, ".git"))));
  ipcMain.handle("repo:worktrees", (_e, root: string) => worktrees(root));
  ipcMain.handle("repo:pick", async (e, from?: string) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const opts = { properties: ["openDirectory" as const], defaultPath: from ? dirname(from) : undefined };
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return res.canceled || !res.filePaths[0] ? null : openIn(e.sender.id, res.filePaths[0]);
  });
  ipcMain.handle("window:theme", (e, frame: string, symbols: string) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (process.platform === "darwin" || !win) return;
    win.setTitleBarOverlay({ color: frame, symbolColor: symbols });
  });
  ipcMain.handle("keys:get", () => loadKeys());
  ipcMain.handle("keys:edit", () => editKeys());
  ipcMain.handle("app:check-updates", () => checkForUpdates(true));
  ipcMain.handle("app:report-issue", () => reportIssue());
  ipcMain.handle("clipboard:write", (_e, text: string) => clipboard.writeText(text));
  ipcMain.handle("git:diff", (_e, root: string, mode: CompareMode) => diff(root, mode));
  ipcMain.handle("git:file", (_e, root: string, mode: CompareMode, file: Pick<FileDiff, "path" | "oldPath" | "status">) => fileContents(root, mode, file));
  ipcMain.handle("git:files", (_e, root: string, mode: CompareMode, files: Pick<FileDiff, "path" | "oldPath" | "status">[]) => manyContents(root, mode, files));
  ipcMain.handle("git:sizes", (_e, root: string, mode: CompareMode, file: Pick<FileDiff, "path" | "oldPath" | "status">) => blobSizes(root, mode, file));
  ipcMain.handle("git:tree", (_e, root: string, mode: CompareMode) => tree(root, mode));
  ipcMain.handle("git:dir", (_e, root: string, dir: string) => listDir(root, dir));
  ipcMain.handle("git:commits", (_e, root: string, limit: number) => commits(root, limit));
  ipcMain.handle("git:commit-detail", (_e, root: string, rev: string) => commitDetail(root, rev));
  ipcMain.handle("git:branches", (_e, root: string) => branches(root));
  ipcMain.handle("git:upstream", (_e, root: string) => upstream(root));
  ipcMain.handle("git:act", (_e, root: string, req: StageRequest) => act(root, req));
  ipcMain.handle("git:act-all", (_e, root: string, req: StageAllRequest) => actAll(root, req));
  ipcMain.handle("git:undo", (_e, root: string) => undo(root));
  ipcMain.handle("git:save-discarded", (_e, root: string, id: string) => saveDiscarded(root, id));
  ipcMain.handle("git:drop-discarded", (_e, root: string, id: string) => dropDiscarded(root, id));
  ipcMain.handle("git:commit", (_e, root: string, message: string) => commit(root, message));
  ipcMain.handle("editor:open", (_e, root: string, path: string, line: number) => openInEditor(root, path, line, loadState().editor));
  ipcMain.handle("file:reveal", (_e, root: string, path: string) => revealFile(root, path));
  ipcMain.handle("file:open", (_e, root: string, path: string) => openWithDefault(root, path));

  const dev = !app.isPackaged;
  ipcMain.handle("dev:hooks", () => ({
    bench: dev && !!process.env.MOIRE_BENCH,
    screenshot: dev && !!process.env.MOIRE_SCREENSHOT,
    prefs: dev && process.env.MOIRE_PREFS ? (JSON.parse(process.env.MOIRE_PREFS) as Record<string, string>) : null,
  }));
  ipcMain.handle("dev:ready", async (e) => {
    const out = process.env.MOIRE_SCREENSHOT;
    if (!dev || !out) return;
    await sleep(300);
    const image = await e.sender.capturePage();
    await writeFile(out, image.toPNG());
    app.quit();
  });
  ipcMain.handle("dev:bench-report", (_e, result: string) => {
    if (!dev) return;
    console.log(result);
    app.quit();
  });
}
