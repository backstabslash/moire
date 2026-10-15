import { existsSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow, Menu, type MenuItemConstructorOptions, shell } from "electron";
import { accelerator, command, type CommandId, COMMANDS } from "../shared/keymap";
import { loadKeys, watchKeys } from "./keys";
import { loadState } from "./state";
import { checkForUpdates } from "./update";

const OS: Record<string, string> = { darwin: "macOS", linux: "Linux", win32: "Windows" };

function send(id: CommandId, arg?: string) {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  win?.webContents.send("menu:command", id, arg);
}

export function reportIssue() {
  const system = `moire ${app.getVersion()}, ${OS[process.platform] ?? process.platform} ${process.getSystemVersion()} (${process.arch})`;
  void shell.openExternal(`https://github.com/backstabslash/moire/issues/new?body=${encodeURIComponent(`\n\n---\n${system}`)}`);
}

export function setupMenu(): void {
  app.setAboutPanelOptions({ applicationName: "moire", applicationVersion: app.getVersion(), website: "https://github.com/backstabslash/moire" });
  buildMenu();
  watchKeys(() => {
    buildMenu();
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send("keys:changed");
  });
}

export function buildMenu(): void {
  const mac = process.platform === "darwin";
  const { keys } = loadKeys();
  // The page handles every key itself, and registered bare letters would swallow typing in text fields.
  // macOS can't show an accelerator without registering it, so there only zoom, which main handles, shows one.
  const shortcut = (id: CommandId) => {
    const accel = keys[id][0] && accelerator(keys[id][0]);
    if (!accel) return {};
    if (!mac) return { accelerator: accel, registerAccelerator: false };
    return command(id).fixed ? { accelerator: accel } : {};
  };
  const item = (id: CommandId, label = COMMANDS[id].label): MenuItemConstructorOptions => ({ id, label, click: () => send(id), ...shortcut(id) });
  const sep: MenuItemConstructorOptions = { type: "separator" };
  const recent = (loadState().recent ?? []).filter((r) => existsSync(join(r, ".git")));
  const about: MenuItemConstructorOptions = { role: "about", label: "About moire" };
  const updates: MenuItemConstructorOptions[] = app.isPackaged ? [{ label: "Check for updates…", click: () => checkForUpdates(true) }] : [];

  const template: MenuItemConstructorOptions[] = [
    ...(mac
      ? [
          {
            label: app.name,
            submenu: [about, ...updates, sep, { role: "services" }, sep, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, sep, { role: "quit" }],
          } as MenuItemConstructorOptions,
        ]
      : []),
    {
      label: "File",
      submenu: [
        item("openRepo"),
        {
          label: "Open recent",
          submenu: [
            ...recent.map((path): MenuItemConstructorOptions => ({ label: path, click: () => send("recentRepos", path) })),
            ...(recent.length ? [sep] : []),
            item("recentRepos", "More…"),
          ],
        },
        sep,
        { role: "close", label: "Close window" },
        ...(mac ? [] : [sep, { role: "quit" } as MenuItemConstructorOptions]),
      ],
    },
    { label: "Edit", submenu: [{ role: "undo" }, { role: "redo" }, sep, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
    {
      label: "View",
      submenu: [
        item("unstaged"),
        item("staged"),
        item("all"),
        item("commit"),
        item("branches"),
        sep,
        item("layout"),
        item("fullFile"),
        item("preview"),
        item("allFiles"),
        item("refresh"),
        sep,
        item("theme"),
        item("zoomIn"),
        item("zoomOut"),
        item("zoomReset"),
        sep,
        { role: "togglefullscreen" },
        ...(app.isPackaged ? [] : ([{ role: "reload" }, { role: "toggleDevTools" }] satisfies MenuItemConstructorOptions[])),
      ],
    },
    {
      label: "Review",
      submenu: [
        item("stage"),
        item("discard"),
        item("stageAll"),
        item("discardFile"),
        item("undo", "Undo last stage or discard"),
        sep,
        item("nextHunk"),
        item("prevHunk"),
        item("firstHunk"),
        item("lastHunk"),
        item("nextFile"),
        item("prevFile"),
        sep,
        item("blink"),
        sep,
        item("search"),
        item("nextHit"),
        item("prevHit"),
        item("filterFiles"),
        sep,
        item("copyMarkdown"),
        item("copyCode"),
        item("openEditor"),
      ],
    },
    {
      role: "help",
      label: "Help",
      submenu: [item("help"), item("editKeys"), sep, { label: "Report an issue…", click: reportIssue }, ...(mac ? [] : [sep, ...updates, about])],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
