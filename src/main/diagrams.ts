import { join } from "node:path";
import { app, WebContentsView } from "electron";
import type { DiagramResult } from "../shared/types";
import { log } from "./log";

const TIME_LIMIT_MS = 6000;

let view: WebContentsView | null = null;
let loaded: Promise<void> | null = null;
let queue: Promise<unknown> = Promise.resolve();

function diagramPage() {
  if (view && loaded) return { web: view.webContents, loaded };
  const created = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, offscreen: true } });
  created.setBounds({ x: 0, y: 0, width: 1200, height: 800 });
  const web = created.webContents;
  web.setWindowOpenHandler(() => ({ action: "deny" }));
  web.on("will-navigate", (e) => e.preventDefault());
  const dev = !app.isPackaged && process.env.ELECTRON_RENDERER_URL;
  view = created;
  loaded = dev ? web.loadURL(`${dev}/diagram.html`) : web.loadFile(join(__dirname, "../renderer/diagram.html"));
  return { web, loaded };
}

function endPage() {
  const web = view?.webContents;
  view = null;
  loaded = null;
  if (!web || web.isDestroyed()) return;
  web.forcefullyCrashRenderer();
  web.close();
}

async function draw(source: string, theme: Record<string, string | boolean>): Promise<DiagramResult> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<DiagramResult>((resolve) => {
    timer = setTimeout(() => {
      endPage();
      resolve({ error: "it took too long to lay out" });
    }, TIME_LIMIT_MS);
  });
  try {
    const page = diagramPage();
    await page.loaded;
    return await Promise.race([page.web.executeJavaScript(`drawDiagram(${JSON.stringify(source)}, ${JSON.stringify(theme)})`) as Promise<DiagramResult>, late]);
  } catch (e) {
    log(`couldn't draw a diagram: ${(e as Error).message}`);
    endPage();
    return { error: "the diagram page stopped" };
  } finally {
    clearTimeout(timer);
  }
}

// A separate process, because a file can write a diagram that lays out for minutes, and only a process can be stopped.
export function drawDiagram(source: string, theme: Record<string, string | boolean>): Promise<DiagramResult> {
  const run = queue.then(() => draw(source, theme));
  queue = run;
  return run;
}

export const closeDiagrams = endPage;
