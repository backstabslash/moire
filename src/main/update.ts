import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { app, BrowserWindow, dialog, type MessageBoxOptions, net, Notification, shell } from "electron";
import { AppImageUpdater } from "electron-updater";
import type { UpdateNotice } from "../shared/types";
import { installedVersion, installKind, type MoveIn, newer, npxRoot, type Release, updateNpx, whyManual } from "./install";
import { real } from "./launch";
import { log } from "./log";
import { loadState } from "./state";

const releases = process.env.MOIRE_RELEASES || "https://api.github.com/repos/backstabslash/moire/releases/latest";
const CHECK_EVERY = 4 * 60 * 60 * 1000;

// Held so the click handler isn't garbage-collected while the notification is up.
let shown: Notification | undefined;

function notify(body: string, onClick: () => void) {
  shown = new Notification({ title: "Moire", body });
  shown.on("click", onClick);
  shown.show();
}

function message(text: string, buttons = ["OK"]): Promise<number> {
  const opts: MessageBoxOptions = { type: "info", message: text, buttons, defaultId: 0, cancelId: buttons.length - 1 };
  const win = BrowserWindow.getFocusedWindow();
  return (win ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts)).then((r) => r.response);
}

function installedByNpx(): boolean {
  return real(app.getPath("exe")).startsWith(real(npxRoot(process.platform, process.env, homedir())) + "/");
}

function packageType(): string | undefined {
  try {
    return readFileSync(join(process.resourcesPath, "package-type"), "utf8").trim();
  } catch {
    return undefined;
  }
}

async function latestRelease(): Promise<Release> {
  const res = await net.fetch(releases, { headers: { Accept: "application/vnd.github+json" } });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  return (await res.json()) as Release;
}

// APPIMAGE is inherited from any AppImage up the process tree, and the updater deletes the file it names.
export function runningAsAppImage(): boolean {
  const { APPIMAGE, APPDIR } = process.env;
  return !!APPIMAGE && !!APPDIR && app.getPath("exe").startsWith(APPDIR + "/");
}

let notice: UpdateNotice | null = null;
let apply: ((repo?: string) => void) | undefined;
interface Found {
  version: string;
  download?: Promise<unknown>;
}

let downloading: Found | undefined;
let checking: Promise<Found | null> | undefined;
let updater: AppImageUpdater | undefined;
let staged: { version: string; moveIn: MoveIn } | undefined;

export function updateNotice(): UpdateNotice | null {
  return notice;
}

export function applyUpdate(repo?: string): void {
  apply?.(repo);
}

function announce(next: UpdateNotice, onApply: (repo?: string) => void) {
  if (notice?.version === next.version) return;
  notice = next;
  apply = onApply;
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send("update:notice", next);
  if (BrowserWindow.getFocusedWindow()) return;
  notify(
    next.manualReason ? `Version ${next.version} is available. Click to download it.` : `Version ${next.version} is ready. Click to restart moire now.`,
    () => applyUpdate(),
  );
}

function withdraw() {
  notice = null;
  apply = undefined;
  staged = undefined;
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send("update:notice", null);
}

function moveStagedIn() {
  if (!staged) return;
  try {
    staged.moveIn();
  } catch (e) {
    log(`couldn't move moire ${staged.version} in: ${(e as Error).message}`);
  }
}

function relaunch(execPath: string, repo = loadState().lastRepo) {
  const flags = process.argv.slice(1).filter((a) => a.startsWith("-"));
  app.relaunch({ execPath, args: repo ? [...flags, repo] : flags });
  app.quit();
}

async function downloadNpx(release: Release, version: string) {
  const mac = process.platform === "darwin";
  const root = npxRoot(process.platform, process.env, homedir());
  if (installedVersion(process.platform, root) !== version) {
    const moveIn = await updateNpx({
      release,
      platform: process.platform,
      arch: process.arch,
      root,
      runningApp: mac ? root : dirname(app.getPath("exe")),
      fetch: net.fetch,
      onSmallFailed: (e) => log(`small update to ${version} failed, downloading all of it: ${e.message}`),
    });
    if (moveIn) staged = { version, moveIn };
  }
  const exe = mac ? join(root, "Contents", "MacOS", "moire") : join(root, "current", "moire");
  announce({ version }, (repo) => relaunch(exe, repo));
}

function appImageUpdater(): AppImageUpdater {
  if (updater) return updater;
  // Built directly because electron-builder can leave a deb or rpm marker in the AppImage, and the default updater would obey it.
  const u = new AppImageUpdater();
  u.logger = null;
  u.on("update-downloaded", ({ version }) => {
    announce({ version }, () => {
      // The new copy starts before this one quits, and would otherwise hand its launch to us and exit.
      app.releaseSingleInstanceLock();
      u.quitAndInstall();
    });
  });
  u.on("error", (e) => log(`update failed: ${e.message}`));
  return (updater = u);
}

async function check(): Promise<Found | null> {
  if (downloading) return downloading;
  const ready = notice && { version: notice.version };
  const kind = installKind(process.platform, installedByNpx(), runningAsAppImage(), packageType());
  if (kind === "appimage") {
    const result = await appImageUpdater().checkForUpdates();
    if (!result?.isUpdateAvailable || result.updateInfo.version === notice?.version) return ready;
    withdraw();
    const download = result.downloadPromise ?? Promise.resolve();
    downloading = { version: result.updateInfo.version, download };
    void download.catch(() => {}).finally(() => (downloading = undefined));
    return downloading;
  }
  const release = await latestRelease();
  const version = release.tag_name.replace(/^v/, "");
  if (!newer(version, notice?.version ?? app.getVersion())) return ready;
  if (kind !== "npx") {
    announce({ version, manualReason: whyManual(kind) }, () => void shell.openExternal(`https://github.com/backstabslash/moire/releases/tag/v${version}`));
    return { version };
  }
  withdraw();
  const download = downloadNpx(release, version);
  downloading = { version, download };
  void download.catch((e: Error) => log(`update to ${version} failed: ${e.message}`)).finally(() => (downloading = undefined));
  return downloading;
}

async function report(found: Found | null) {
  if (!found) {
    await message(`moire ${app.getVersion()} is the latest version.`);
    return;
  }
  const { version, download } = found;
  if (!notice) {
    const failed = download?.then(
      () => undefined,
      (e: Error) => e,
    );
    await message(`Downloading moire ${version}. A "Restart to update" button appears in the status bar once it's ready.`);
    const e = await failed;
    if (e) await message(`Couldn't download moire ${version}: ${e.message}`);
    return;
  }
  const { manualReason } = notice;
  const pick = await message(manualReason ? `moire ${version} is available. ${manualReason}` : `moire ${version} is ready.`, [
    manualReason ? "Open release page" : "Restart now",
    "Later",
  ]);
  if (pick === 0) applyUpdate();
}

export function checkForUpdates(manual = false) {
  if (!app.isPackaged) return;
  checking ??= check().finally(() => (checking = undefined));
  checking.then(
    (found) => manual && void report(found),
    (e: Error) => (manual ? void message(`Couldn't check for updates: ${e.message}`) : log(`update check failed: ${e.message}`)),
  );
}

export function startUpdates() {
  if (!app.isPackaged) return;
  app.on("will-quit", moveStagedIn);
  checkForUpdates();
  setInterval(() => checkForUpdates(), CHECK_EVERY);
}
