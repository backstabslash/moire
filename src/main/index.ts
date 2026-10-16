import { spawn } from "node:child_process";
import { join } from "node:path";
import { app, BrowserWindow, nativeTheme, shell } from "electron";
import type { RepoInfo } from "../shared/types";
import { setShellPath } from "./git";
import { launchRepo, registerIpc, showRepo, windowShowing } from "./ipc";
import { isLaunchRequest, type LaunchRequest, launchRequest, loginPath, mergePath } from "./launch";
import { log } from "./log";
import { setupMenu } from "./menu";
import { handlePreviewProtocol, registerPreviewScheme } from "./preview";
import { runningAsAppImage, startUpdates } from "./update";
import { registerZoomIpc, setupZoom } from "./zoom";

function createWindow(repo: Promise<RepoInfo | null>) {
  const dark = nativeTheme.shouldUseDarkColors;
  const mac = process.platform === "darwin";
  const hidden = !app.isPackaged && !!process.env.MOIRE_HIDDEN;
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    show: false,
    backgroundColor: dark ? "#171c22" : "#f4f5f2",
    icon: app.isPackaged ? join(process.resourcesPath, "icon.png") : join(__dirname, "../../build/icons/512x512.png"),
    titleBarStyle: mac ? "hiddenInset" : "hidden",
    autoHideMenuBar: true,
    ...(mac ? { trafficLightPosition: { x: 20, y: 19 } } : {}),
    ...(mac ? {} : { titleBarOverlay: { height: 51, color: dark ? "#1f252c" : "#e6e9e6", symbolColor: "#56606b" } }),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: true,
      contextIsolation: true,
      offscreen: hidden,
    },
  });
  showRepo(win.webContents, repo);
  if (!hidden) win.once("ready-to-show", () => win.show());
  setupZoom(win);
  win.webContents.on("will-navigate", (e, url) => {
    if (url === win.webContents.getURL()) return;
    e.preventDefault();
    if (/^https?:/i.test(url)) void shell.openExternal(url);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  if (!app.isPackaged) {
    win.webContents.on("console-message", ({ level, message, lineNumber, sourceId }) => {
      if (level === "warning" || level === "error") console.log(`[renderer ${level}] ${message.slice(0, 400)} (${sourceId}:${lineNumber})`);
    });
  }

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

async function openRequest(req: LaunchRequest) {
  const repo = launchRepo(req, false);
  const info = await repo.catch(() => undefined);
  const existing = info && windowShowing(info.root);
  if (!existing) return createWindow(repo);
  if (existing.isMinimized()) existing.restore();
  existing.focus();
  if (process.platform === "darwin") app.focus({ steal: true });
}

function resolveShellPath() {
  const path = loginPath(process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/sh"), 5000).then((shellPath) => {
    if (!shellPath) {
      log("couldn't read PATH from the login shell");
      return null;
    }
    const current = process.env.PATH ?? "";
    // Finder's PATH is only the system folders; a desktop menu's PATH is right but may miss what shell rc files add.
    const merged = process.platform === "darwin" ? mergePath(shellPath, current) : mergePath(current, shellPath);
    process.env.PATH = merged;
    return merged;
  });
  setShellPath(path);
}

// From a terminal, run in the background like `code`, so Chromium's logging and Ctrl+C don't reach the app.
function detach(): boolean {
  if (!app.isPackaged || process.platform !== "linux" || !(process.stdout.isTTY || process.stderr.isTTY)) return false;
  app.releaseSingleInstanceLock();
  const exe = runningAsAppImage() ? process.env.APPIMAGE! : process.execPath;
  const child = spawn(exe, process.argv.slice(1), { detached: true, stdio: "ignore" });
  child.once("spawn", () => app.exit(0));
  child.once("error", (e) => {
    log(`couldn't start in the background: ${e.message}`);
    app.exit(1);
  });
  child.unref();
  return true;
}

function start(request: LaunchRequest) {
  process.on("uncaughtExceptionMonitor", (e, origin) => log(`${origin}: ${e.stack ?? e.message}`));
  app.on("render-process-gone", (_e, _contents, { reason }) => reason !== "clean-exit" && log(`window crashed: ${reason}`));
  if (app.isPackaged) resolveShellPath();
  registerIpc();
  registerZoomIpc();
  registerPreviewScheme();
  let dropped: string | undefined;
  app.on("open-file", (e, path) => {
    e.preventDefault();
    if (app.isReady()) void openRequest({ path, cwd: path });
    else dropped = path;
  });
  app.on("second-instance", (_e, argv, cwd, data) => {
    void openRequest(isLaunchRequest(data) ? data : launchRequest(argv, cwd, app.isPackaged));
  });
  void app.whenReady().then(() => {
    handlePreviewProtocol();
    setupMenu();
    createWindow(launchRepo(dropped ? { path: dropped, cwd: request.cwd } : request, true));
    startUpdates();
  });
  app.on("window-all-closed", () => app.quit());
}

const request = launchRequest(process.argv, process.cwd(), app.isPackaged);
// Dev runs share userData with the installed app, so only packaged builds and isolated test runs take the lock.
const single = app.isPackaged || app.commandLine.hasSwitch("user-data-dir");
if (single && !app.requestSingleInstanceLock(request)) app.quit();
else if (!detach()) start(request);
