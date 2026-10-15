import { join } from "node:path";
import { app, BrowserWindow, nativeTheme, shell } from "electron";
import { registerIpc } from "./ipc";
import { handlePreviewProtocol, registerPreviewScheme } from "./preview";
import { checkForUpdates } from "./update";
import { registerZoomIpc, setupZoom } from "./zoom";

function createWindow() {
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
    ...(mac ? { trafficLightPosition: { x: 20, y: 19 } } : {}),
    ...(mac ? {} : { titleBarOverlay: { height: 51, color: dark ? "#1f252c" : "#e6e9e6", symbolColor: "#56606b" } }),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: true,
      contextIsolation: true,
      offscreen: hidden,
    },
  });
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

registerIpc();
registerZoomIpc();
registerPreviewScheme();
void app.whenReady().then(() => {
  handlePreviewProtocol();
  createWindow();
  checkForUpdates();
});
app.on("window-all-closed", () => app.quit());
