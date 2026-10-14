import type { FileDiff } from "../../../shared/types";

const dirOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

// Folder first, then name: the order the sidebar shows, so [ ] and j k walk files the way they're listed.
export function orderFiles(files: FileDiff[]): FileDiff[] {
  return [...files].sort((x, y) => dirOf(x.path).localeCompare(dirOf(y.path)) || x.path.localeCompare(y.path));
}

// Keyed by what the file's diff contains, so a refresh that changed nothing keeps contents and colours.
export function fileKey(modeKey: string, file: FileDiff): string {
  return `${modeKey}:${file.path}:${hashString(JSON.stringify(file))}`;
}

export function hashString(text: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

// Every character of the query, ignoring spaces and case, appears in the path in order.
export function fuzzyMatch(query: string, path: string): boolean {
  const q = query.toLowerCase().replace(/\s+/g, "");
  let i = 0;
  for (const ch of path.toLowerCase()) if (ch === q[i]) i++;
  return i === q.length;
}
