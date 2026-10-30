import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import type { SavedWindow } from "./bounds";

interface State {
  lastRepo?: string;
  recent?: string[];
  editor?: string;
  zoom?: number;
  window?: SavedWindow;
}

const file = () => join(app.getPath("userData"), "state.json");

export function loadState(): State {
  try {
    return JSON.parse(readFileSync(file(), "utf8")) as State;
  } catch {
    return {};
  }
}

export function saveState(patch: State): void {
  const tmp = `${file()}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...loadState(), ...patch }, null, 2));
  renameSync(tmp, file());
}
