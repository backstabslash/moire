import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";

interface State {
  lastRepo?: string;
  // most recent first
  recent?: string[];
  // command template for opening files, like "code -g {file}:{line}"
  editor?: string;
  // window zoom factor, 1 is 100%
  zoom?: number;
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
  writeFileSync(file(), JSON.stringify({ ...loadState(), ...patch }, null, 2));
}
