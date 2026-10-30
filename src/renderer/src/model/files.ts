import type { FileDiff } from "../../../shared/types";

const dirOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const collator = new Intl.Collator();
const byFolder = (x: string, y: string) => collator.compare(dirOf(x), dirOf(y)) || collator.compare(x, y);

const TEST_NAME = /^(?:test_(.+)\.py|(.+)(?:\.test|\.spec|_test)\.[^.]+)$/;
const SOURCE = /\.(c|cc|cjs|cpp|cs|cts|dart|ex|exs|go|h|hpp|java|jsx?|kt|mjs|mts|php|py|rb|rs|scala|svelte|swift|tsx?|vue)$/;

export interface ListedFile {
  file: FileDiff;
  suffix?: string;
}

export function listFiles(files: FileDiff[]): ListedFile[] {
  const sorted = [...files].sort((x, y) => byFolder(x.path, y.path));
  const nameOf = (f: FileDiff) => f.path.slice(f.path.lastIndexOf("/") + 1);
  const code = new Map<string, FileDiff>();
  for (const f of sorted) {
    const name = nameOf(f);
    if (SOURCE.test(name) && !TEST_NAME.test(name)) code.set(`${dirOf(f.path)}/${name.replace(/\.[^.]+$/, "")}`, f);
  }
  const tucked = new Map<FileDiff, ListedFile[]>();
  const placed = new Set<FileDiff>();
  for (const f of sorted) {
    const name = nameOf(f);
    const test = TEST_NAME.exec(name);
    const base = test?.[1] ?? test?.[2];
    const lead = base && code.get(`${dirOf(f.path)}/${base}`);
    if (!base || !lead) continue;
    placed.add(f);
    tucked.set(lead, [...(tucked.get(lead) ?? []), { file: f, suffix: name.startsWith(base) ? name.slice(base.length) : name }]);
  }
  return sorted.filter((f) => !placed.has(f)).flatMap((file) => [{ file }, ...(tucked.get(file) ?? [])]);
}

export function orderFiles(files: FileDiff[]): FileDiff[] {
  return listFiles(files).map((row) => row.file);
}

export function orderPaths(paths: string[]): string[] {
  return [...paths].sort(byFolder);
}

export function fileKey(modeKey: string, file: FileDiff): string {
  return `${modeKey}:${file.path}:${file.version ?? hashString(JSON.stringify(file))}`;
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

const CACHE_LIMIT = 24;

export function remember<V>(cache: Map<string, V>, key: string, value: V) {
  cache.set(key, value);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
}
