import { existsSync, readFileSync, watch } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app, shell } from "electron";
import { defaultKeysFile, type ResolvedKeys, resolveKeys } from "../shared/keymap";

const FILE = "keys.json";
const keysFile = () => join(app.getPath("userData"), FILE);

export function loadKeys(): ResolvedKeys {
  let text: string | null = null;
  try {
    text = readFileSync(keysFile(), "utf8");
  } catch {}
  return resolveKeys(text);
}

export async function editKeys(): Promise<void> {
  const file = keysFile();
  if (!existsSync(file)) await writeFile(file, defaultKeysFile());
  const error = await shell.openPath(file);
  if (error) throw new Error(error);
}

// Editors save by replacing the file, so the folder is watched rather than the file.
export function watchKeys(onChange: () => void): void {
  let timer: NodeJS.Timeout | undefined;
  try {
    watch(app.getPath("userData"), (_event, name) => {
      if (name !== FILE) return;
      clearTimeout(timer);
      timer = setTimeout(onChange, 100);
    }).on("error", () => {});
  } catch {}
}
