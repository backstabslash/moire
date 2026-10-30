import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { app, BrowserWindow, clipboard, dialog, ipcMain, type IpcMainInvokeEvent, webContents, type WebContents } from "electron";
import type { ClashChoice, CompareMode, CopyPlan, FileDiff, RepoInfo, StageAllRequest, StageRequest, UpdateNotice } from "../shared/types";
import {
  blobSizes,
  branches,
  commitDetail,
  commits,
  diff,
  fileContents,
  gitMissing,
  isFolder,
  keepUntrackedCache,
  listDir,
  manyContents,
  repoInfo,
  setScratchDir,
  tree,
  upstream,
  worktrees,
} from "./git";
import { compareMode } from "./compare";
import { clashDiff, copyIn, planCopy } from "./copyin";
import { chooseEditor, installedEditors, openInEditor } from "./editor";
import { clipboardFiles, dragOut, pickFiles } from "./filesin";
import { editKeys, loadKeys } from "./keys";
import { buildMenu, reportIssue } from "./menu";
import { readNotes } from "./notes";
import { type LaunchRequest, usableCwd } from "./launch";
import { openWithDefault, revealFile } from "./open";
import { allowPreviews } from "./preview";
import { act, actAll, adoptLegacyUndo, commit, dropDiscarded, saveDiscarded, undo } from "./stage";
import { loadState, saveState } from "./state";
import { applyUpdate, checkForUpdates, updateNotice } from "./update";
import { RepoWatcher } from "./watch";

const RECENT_LIMIT = 10;

async function openRepo(path: string, implicit = false): Promise<RepoInfo> {
  const info = await repoInfo(path);
  if (!info.folder || !implicit) {
    const recent = [info.root, ...(loadState().recent ?? []).filter((r) => r !== info.root)].slice(0, RECENT_LIMIT);
    saveState(info.folder ? { recent } : { lastRepo: info.root, recent });
  }
  buildMenu();
  allowPreviews(info.root);
  if (!info.folder) void adoptLegacyUndo(info.root, join(app.getPath("userData"), "undo.json")).catch(() => {});
  return info;
}

export async function launchRepo({ path, compare, cwd }: LaunchRequest, fallback: boolean): Promise<RepoInfo | null> {
  const missing = await gitMissing();
  if (missing) throw new Error(missing);
  if (path) return openRepo(path);
  if (compare) return openRepo((!app.isPackaged && process.env.MOIRE_REPO) || cwd);
  const candidates = [app.isPackaged ? usableCwd(cwd) : process.env.MOIRE_REPO, fallback ? loadState().lastRepo : undefined];
  let folder: string | null = null;
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if (!(await repoInfo(candidate)).folder) return await openRepo(candidate, true);
      folder ??= candidate;
    } catch {}
  }
  return folder ? openRepo(folder, true) : null;
}

const launches = new Map<number, Promise<RepoInfo | null>>();
const shown = new Map<number, string>();
const comparisons = new Map<number, string[]>();

export function askToCompare(contents: WebContents, compare: string[]): void {
  comparisons.set(contents.id, compare);
  contents.send("repo:compare");
}

export function showRepo(contents: WebContents, repo: Promise<RepoInfo | null>, compare?: string[]): void {
  const id = contents.id;
  launches.set(id, repo);
  if (compare) comparisons.set(id, compare);
  void repo.then(
    (info) => {
      if (info && !shown.has(id)) shown.set(id, info.root);
    },
    () => {
      comparisons.delete(id);
    },
  );
  contents.once("destroyed", () => {
    launches.delete(id);
    shown.delete(id);
    comparisons.delete(id);
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

function gitOnly<A extends unknown[], R>(run: (root: string, ...args: A) => R) {
  return (_e: IpcMainInvokeEvent, root: string, ...args: A): R => {
    if (isFolder(root)) throw new Error(`${basename(root)} isn't a git repository`);
    return run(root, ...args);
  };
}

const watchers = new Map<number, RepoWatcher>();
const dropUnwatchedCaches = () => keepUntrackedCache([...watchers.values()].map((w) => w.root));

export function registerIpc(): void {
  const dev = !app.isPackaged;
  setScratchDir(join(app.getPath("userData"), "folder.git"));
  ipcMain.handle("repo:watch", async (e, root: string) => {
    const id = e.sender.id;
    const sender = e.sender;
    if (watchers.get(id)?.root === root && watchers.get(id)?.folder === isFolder(root)) return;
    if (!watchers.has(id)) {
      sender.once("destroyed", () => {
        watchers.get(id)?.close();
        watchers.delete(id);
        dropUnwatchedCaches();
      });
    }
    watchers.get(id)?.close();
    const watcher = new RepoWatcher(root, () => {
      if (!sender.isDestroyed()) sender.send("repo:changed");
    });
    watchers.set(id, watcher);
    dropUnwatchedCaches();
    await watcher.start();
  });
  ipcMain.handle("repo:watchFolders", (e, root: string, dirs: string[]) => {
    const watcher = watchers.get(e.sender.id);
    if (watcher?.root === root) watcher.setOpen(dirs);
  });
  ipcMain.handle("repo:initial", (e) => {
    const root = shown.get(e.sender.id);
    return root ? openRepo(root, true) : (launches.get(e.sender.id) ?? launchRepo({ cwd: process.cwd() }, true));
  });
  ipcMain.handle("repo:take-compare", (e) => {
    const compare = comparisons.get(e.sender.id) ?? null;
    comparisons.delete(e.sender.id);
    return compare;
  });
  ipcMain.handle("repo:open", (e, path: string) => openIn(e.sender.id, path));
  ipcMain.handle("repo:recent", () => (loadState().recent ?? []).filter((r) => existsSync(r)));
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
  ipcMain.handle("update:get", () => (dev && process.env.MOIRE_UPDATE ? (JSON.parse(process.env.MOIRE_UPDATE) as UpdateNotice) : updateNotice()));
  ipcMain.handle("update:apply", (e) => applyUpdate(shown.get(e.sender.id)));
  ipcMain.handle("app:report-issue", () => reportIssue());
  ipcMain.handle("app:version", () => app.getVersion());
  ipcMain.handle("clipboard:write", (_e, text: string) => clipboard.writeText(text));
  ipcMain.handle("git:diff", (_e, root: string, mode: CompareMode) => diff(root, mode));
  ipcMain.handle("git:file", (_e, root: string, mode: CompareMode, file: Pick<FileDiff, "path" | "oldPath" | "status">) => fileContents(root, mode, file));
  ipcMain.handle("git:files", (_e, root: string, mode: CompareMode, files: Pick<FileDiff, "path" | "oldPath" | "status">[]) => manyContents(root, mode, files));
  ipcMain.handle("git:sizes", (_e, root: string, mode: CompareMode, file: Pick<FileDiff, "path" | "oldPath" | "status">) => blobSizes(root, mode, file));
  ipcMain.handle("git:tree", (_e, root: string, mode: CompareMode) => tree(root, mode));
  ipcMain.handle("git:dir", (_e, root: string, dir: string) => listDir(root, dir));
  ipcMain.handle("git:commits", gitOnly(commits));
  ipcMain.handle("git:commit-detail", gitOnly(commitDetail));
  ipcMain.handle("git:branches", gitOnly(branches));
  ipcMain.handle("git:compare", gitOnly(compareMode));
  ipcMain.handle("git:upstream", (_e, root: string) => upstream(root));
  ipcMain.handle(
    "git:act",
    gitOnly((root, req: StageRequest) => act(root, req)),
  );
  ipcMain.handle(
    "git:act-all",
    gitOnly((root, req: StageAllRequest) => actAll(root, req)),
  );
  ipcMain.handle(
    "git:undo",
    gitOnly((root, only?: string) => undo(root, only)),
  );
  ipcMain.handle("git:save-discarded", gitOnly(saveDiscarded));
  ipcMain.handle("git:drop-discarded", gitOnly(dropDiscarded));
  ipcMain.handle("git:commit", gitOnly(commit));
  ipcMain.handle("notes:get", (_e, root: string, commit?: string) => (isFolder(root) ? { path: "", notes: null } : readNotes(root, commit)));
  ipcMain.handle("editor:open", (_e, root: string, path: string, line: number) => openInEditor(root, path, line, loadState().editor));
  ipcMain.handle("editor:list", () => installedEditors());
  ipcMain.handle("editor:choose", (_e, template: string) => {
    const { editor, name } = chooseEditor(template);
    saveState({ editor });
    return name;
  });
  ipcMain.handle("file:reveal", (_e, root: string, path: string) => revealFile(root, path));
  ipcMain.handle("file:open", (_e, root: string, path: string) => openWithDefault(root, path));
  ipcMain.handle("file:drag", (e, root: string, path: string) => dragOut(e.sender, root, path));
  ipcMain.handle(
    "files:plan",
    gitOnly((root, sources: string[], dir: string) => planCopy(root, sources, dir)),
  );
  ipcMain.handle(
    "files:copy",
    gitOnly((root, plan: CopyPlan, decisions: Record<string, ClashChoice>) => copyIn(root, plan, decisions)),
  );
  ipcMain.handle(
    "files:clash-diff",
    gitOnly((root, source: string, dest: string) => clashDiff(root, source, dest)),
  );
  ipcMain.handle("files:clipboard", () => clipboardFiles());
  ipcMain.handle("files:pick", (e) => pickFiles(e.sender));

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
