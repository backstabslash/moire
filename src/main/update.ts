import { homedir } from "node:os";
import { join } from "node:path";
import { app, clipboard, Notification, shell } from "electron";
import { AppImageUpdater } from "electron-updater";

const npx = "npx @backstabslash/moire";

// Held so the click handler isn't garbage-collected while the notification is up.
let shown: Notification | undefined;

function notify(body: string, onClick: () => void) {
  shown = new Notification({ title: "moire", body });
  shown.on("click", onClick);
  shown.show();
}

function newer(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
}

function installedByNpx(): boolean {
  const data = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  const root = process.platform === "darwin" ? join(homedir(), "Applications", "moire.app") : join(data, "moire");
  return app.getPath("exe").startsWith(root + "/");
}

async function latestVersion(): Promise<string> {
  const res = await fetch("https://api.github.com/repos/backstabslash/moire/releases/latest", { headers: { Accept: "application/vnd.github+json" } });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  return ((await res.json()) as { tag_name: string }).tag_name.replace(/^v/, "");
}

// APPIMAGE is inherited from any AppImage up the process tree, and the updater deletes the file it names.
function runningAsAppImage(): boolean {
  const { APPIMAGE, APPDIR } = process.env;
  return !!APPIMAGE && !!APPDIR && app.getPath("exe").startsWith(APPDIR + "/");
}

export function checkForUpdates() {
  if (!app.isPackaged) return;
  if (runningAsAppImage()) {
    // Built directly because electron-builder can leave a deb or rpm marker in the AppImage, and the default updater would obey it.
    const updater = new AppImageUpdater();
    updater.logger = null;
    updater.on("update-downloaded", ({ version }) => {
      notify(`Version ${version} will be used next time you open moire. Click to restart now.`, () => updater.quitAndInstall());
    });
    updater.on("error", (e) => console.log(`update check failed: ${e.message}`));
    updater.checkForUpdates().catch(() => {});
    return;
  }
  latestVersion()
    .then((version) => {
      if (!newer(version, app.getVersion())) return;
      if (installedByNpx()) {
        notify(`Version ${version} is available. Click to copy the command that updates it: ${npx}`, () => void clipboard.writeText(npx));
      } else {
        notify(`Version ${version} is available. Click to download it.`, () => {
          void shell.openExternal(`https://github.com/backstabslash/moire/releases/tag/v${version}`);
        });
      }
    })
    .catch((e: Error) => console.log(`update check failed: ${e.message}`));
}
