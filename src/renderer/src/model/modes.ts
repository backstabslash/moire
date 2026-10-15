import type { FileDiff } from "../../../shared/types";

export const LINK = "120000";
export const MODULE = "160000";
const EXEC = "100755";

const kind = (mode: string) => (mode === LINK ? "symlink" : mode === MODULE ? "submodule" : "file");

export interface ModeNote {
  words: string;
  tag: string;
}

export function modeNote({ oldMode: a, newMode: b }: Pick<FileDiff, "oldMode" | "newMode">): ModeNote | null {
  if (a && b && a !== b) {
    const to = kind(b);
    if (kind(a) !== to) return { words: `file type changed to ${to}`, tag: to === "symlink" ? "link" : to === "submodule" ? "sub" : "file" };
    return b === EXEC ? { words: "now executable", tag: "+x" } : { words: "no longer executable", tag: "−x" };
  }
  const mode = b ?? a;
  if (mode === LINK) return { words: "symlink", tag: "link" };
  if (mode === MODULE) return { words: "submodule", tag: "sub" };
  if (!a && b === EXEC) return { words: "executable", tag: "+x" };
  return null;
}
