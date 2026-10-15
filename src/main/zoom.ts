import { type BrowserWindow, ipcMain } from "electron";
import { loadState, saveState } from "./state";

const CHROME_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

export function stepZoom(current: number, delta: -1 | 1): number {
  if (delta > 0) return CHROME_STEPS.find((s) => s > current + 0.001) ?? CHROME_STEPS[CHROME_STEPS.length - 1];
  return CHROME_STEPS.findLast((s) => s < current - 0.001) ?? CHROME_STEPS[0];
}

// Electron's default menu only zooms in on Ctrl+Plus, which most layouts reach with Shift.
export function setupZoom(win: BrowserWindow) {
  const contents = win.webContents;
  const set = (factor: number) => {
    contents.setZoomFactor(factor);
    saveState({ zoom: factor });
    contents.send("zoom:changed", factor);
  };
  contents.on("did-finish-load", () => contents.setZoomFactor(loadState().zoom ?? 1));
  contents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || input.alt || !(process.platform === "darwin" ? input.meta : input.control)) return;
    const factor = contents.getZoomFactor();
    if (input.key === "=" || input.key === "+") set(stepZoom(factor, 1));
    else if (input.key === "-" || input.key === "_") set(stepZoom(factor, -1));
    else if (input.key === "0") set(1);
    else return;
    event.preventDefault();
  });
}

export function registerZoomIpc() {
  ipcMain.handle("zoom:get", (e) => e.sender.getZoomFactor());
  ipcMain.handle("zoom:reset", (e) => {
    e.sender.setZoomFactor(1);
    saveState({ zoom: 1 });
    e.sender.send("zoom:changed", 1);
  });
}
