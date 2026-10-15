import type { FileDiff } from "../../../shared/types";

const dirOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const collator = new Intl.Collator();
const byFolder = (x: string, y: string) => collator.compare(dirOf(x), dirOf(y)) || collator.compare(x, y);

export function orderFiles(files: FileDiff[]): FileDiff[] {
  return [...files].sort((x, y) => byFolder(x.path, y.path));
}

export function orderPaths(paths: string[]): string[] {
  return [...paths].sort(byFolder);
}

export function fileKey(modeKey: string, file: FileDiff): string {
  return `${modeKey}:${file.path}:${hashString(JSON.stringify(file))}`;
}

export function hashString(text: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

export function fuzzyMatch(query: string, path: string): boolean {
  const q = query.toLowerCase().replace(/\s+/g, "");
  let i = 0;
  for (const ch of path.toLowerCase()) if (ch === q[i]) i++;
  return i === q.length;
}
