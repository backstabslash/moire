import { existsSync, lstatSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app, shell } from "electron";
import { watchUserFile } from "./keys";

const FILE = "themes.json";
const themesFile = () => join(app.getPath("userData"), FILE);

const STARTER = {
  "//": 'Add themes to the list, then save. A theme starts from a built-in one and changes only what you name. Set "plate", "ink", "a" and "b" and the rest follows from them. A plate of the other tone takes the rest from a built-in of that tone.',
  "//example": { name: "Harbour", extends: "anodic", colors: { plate: "#1c2326", a: "#e0a050", b: "#70b8d0" } },
  themes: [],
};

export function loadThemes(): string | null {
  try {
    return readFileSync(themesFile(), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT" && !lstatSync(themesFile(), { throwIfNoEntry: false })) return null;
    throw e;
  }
}

export async function editThemes(): Promise<void> {
  const file = themesFile();
  if (!existsSync(file)) await writeFile(file, `${JSON.stringify(STARTER, null, 2)}\n`);
  const error = await shell.openPath(file);
  if (error) throw new Error(error);
}

export const watchThemes = (onChange: () => void) => watchUserFile(FILE, onChange);
