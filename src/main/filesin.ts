import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { app, BrowserWindow, clipboard, dialog, nativeImage, type NativeImage, type WebContents } from "electron";
import { fileUris } from "./copyin";

// The uri list Chromium maps, or raw: GNOME's own list, a uri list it didn't map, and macOS's file URLs.
const FILE_TYPES = /^text\/uri-list$|format="(text\/uri-list|x-special\/gnome-copied-files|public\.file-url)"/;

export async function clipboardFiles(): Promise<string[]> {
  const paths: string[] = [];
  for (const item of await clipboard.read()) {
    for (const type of item.types.filter((t) => FILE_TYPES.test(t))) {
      const blob = (await item.getType(type).catch(() => null)) as Blob | null;
      for (const path of fileUris((await blob?.text()) ?? "")) if (!paths.includes(path)) paths.push(path);
    }
  }
  return paths;
}

export async function pickFiles(sender: WebContents): Promise<string[]> {
  const win = BrowserWindow.fromWebContents(sender);
  const opts = { title: "Copy files here", buttonLabel: "Copy here", properties: ["openFile" as const, "multiSelections" as const] };
  const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  return res.canceled ? [] : res.filePaths;
}

let icon: NativeImage | null = null;

// On Linux and Windows this returns once the drop lands or is cancelled; on macOS it returns at once.
export function dragOut(sender: WebContents, root: string, path: string): void {
  if (!path || isAbsolute(path) || path.split("/").includes("..") || !existsSync(join(root, path))) return;
  icon ??= nativeImage
    .createFromPath(app.isPackaged ? join(process.resourcesPath, "icon.png") : join(__dirname, "../../build/icons/512x512.png"))
    .resize({ width: 32, height: 32 });
  sender.startDrag({ file: join(root, path), icon });
}
