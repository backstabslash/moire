import { appendFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";

const MAX_BYTES = 256 * 1024;

export function log(message: string): void {
  if (!app.isPackaged) console.log(message);
  try {
    const file = join(app.getPath("userData"), "moire.log");
    if ((statSync(file, { throwIfNoEntry: false })?.size ?? 0) > MAX_BYTES) renameSync(file, `${file}.old`);
    appendFileSync(file, `${new Date().toISOString()} ${message}\n`);
  } catch {}
}
