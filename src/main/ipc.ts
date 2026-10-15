import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { app, BrowserWindow, clipboard, dialog, ipcMain } from "electron";
import type { CompareMode, FileDiff, RepoInfo, StageRequest } from "../shared/types";
import { blobSizes, branches, commits, diff, fileContents, listDir, manyContents, repoInfo, tree } from "./git";
import { openInEditor } from "./editor";
import { openWithDefault, revealFile } from "./open";
import { allowPreviews } from "./preview";
import { act, commit, undo } from "./stage";
import { loadState, saveState } from "./state";
import { RepoWatcher } from "./watch";

const RECENT_LIMIT = 10;

async function openRepo(path: string): Promise<RepoInfo> {
  const info = await repoInfo(path);
  const recent = [info.root, ...(loadState().recent ?? []).filter((r) => r !== info.root)].slice(0, RECENT_LIMIT);
  saveState({ lastRepo: info.root, recent });
  allowPreviews(info.root);
  return info;
}

async function initialRepo(): Promise<RepoInfo | null> {
  const arg = process.argv.slice(app.isPackaged ? 1 : 2).find((a) => !a.startsWith("-"));
  const candidates = [arg && resolve(arg), app.isPackaged ? undefined : process.env.MOIRE_REPO, loadState().lastRepo];
  for (const path of candidates) {
    if (!path) continue;
    try {
      return await openRepo(path);
    } catch {}
  }
  return null;
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
  ipcMain.handle("repo:initial", () => initialRepo());
  ipcMain.handle("repo:open", (_e, path: string) => openRepo(path));
  ipcMain.handle("repo:recent", () => (loadState().recent ?? []).filter((r) => existsSync(join(r, ".git"))));
  ipcMain.handle("repo:pick", async (e, from?: string) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const opts = { properties: ["openDirectory" as const], defaultPath: from ? dirname(from) : undefined };
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return res.canceled || !res.filePaths[0] ? null : openRepo(res.filePaths[0]);
  });
  ipcMain.handle("window:theme", (e, frame: string, symbols: string) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (process.platform === "darwin" || !win) return;
    win.setTitleBarOverlay({ color: frame, symbolColor: symbols });
  });
  ipcMain.handle("clipboard:write", (_e, text: string) => clipboard.writeText(text));
  ipcMain.handle("git:diff", (_e, root: string, mode: CompareMode) => diff(root, mode));
  ipcMain.handle("git:file", (_e, root: string, mode: CompareMode, file: Pick<FileDiff, "path" | "oldPath" | "status">) => fileContents(root, mode, file));
  ipcMain.handle("git:files", (_e, root: string, mode: CompareMode, files: Pick<FileDiff, "path" | "oldPath" | "status">[]) => manyContents(root, mode, files));
  ipcMain.handle("git:sizes", (_e, root: string, mode: CompareMode, file: Pick<FileDiff, "path" | "oldPath" | "status">) => blobSizes(root, mode, file));
  ipcMain.handle("git:tree", (_e, root: string, mode: CompareMode) => tree(root, mode));
  ipcMain.handle("git:dir", (_e, root: string, dir: string) => listDir(root, dir));
  ipcMain.handle("git:commits", (_e, root: string, limit: number) => commits(root, limit));
  ipcMain.handle("git:branches", (_e, root: string) => branches(root));
  const undoLog = () => join(app.getPath("userData"), "undo.json");
  ipcMain.handle("git:act", (_e, root: string, req: StageRequest) => act(root, req, undoLog()));
  ipcMain.handle("git:undo", (_e, root: string) => undo(root, undoLog()));
  ipcMain.handle("git:commit", (_e, root: string, message: string) => commit(root, message, undoLog()));
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
