import { fuzzyMatch } from "./files";

export function rankByLabel<T extends { label: string }>(query: string, items: readonly T[]): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...items];
  const rank = (label: string) => {
    const text = label.toLowerCase();
    if (text.startsWith(q)) return 0;
    if (text.includes(` ${q}`)) return 1;
    if (text.includes(q)) return 2;
    return fuzzyMatch(q, text) ? 3 : 4;
  };
  return items
    .map((item) => ({ item, at: rank(item.label) }))
    .filter(({ at }) => at < 4)
    .sort((x, y) => x.at - y.at)
    .map(({ item }) => item);
}
