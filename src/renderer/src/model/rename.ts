export type NameParts = [before: string, changed: string, after: string];

const alnum = (c: string) => /[\p{L}\p{N}]/u.test(c);
const isBoundary = (s: string, i: number) =>
  i <= 0 || i >= s.length || !alnum(s[i - 1]) || !alnum(s[i]) || (s[i - 1] !== s[i - 1].toUpperCase() && s[i] !== s[i].toLowerCase());

export function renameParts(oldPath: string, newPath: string): [NameParts, NameParts] {
  const a = oldPath.split("/");
  const b = newPath.split("/");
  let dirs = 0;
  while (dirs < a.length - 1 && dirs < b.length - 1 && a[dirs] === b[dirs]) dirs++;
  const x = a.slice(dirs).join("/");
  const y = b.slice(dirs).join("/");
  let pre = 0;
  while (pre < x.length && pre < y.length && x[pre] === y[pre]) pre++;
  while (!isBoundary(x, pre) || !isBoundary(y, pre)) pre--;
  let post = 0;
  while (post < x.length - pre && post < y.length - pre && x[x.length - 1 - post] === y[y.length - 1 - post]) post++;
  while (!isBoundary(x, x.length - post) || !isBoundary(y, y.length - post)) post--;
  const split = (s: string): NameParts => [s.slice(0, pre), s.slice(pre, s.length - post), s.slice(s.length - post)];
  return [split(x), split(y)];
}
