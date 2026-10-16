import type { FileDiff, FileTree } from "../../../shared/types";

const collator = new Intl.Collator();

export interface Dir {
  path: string;
  name: string;
  dirs: Dir[];
  files: { path: string; diff?: FileDiff; ignored: boolean }[];
  ignored: boolean;
  changes: number;
}

export function parentDirs(path: string | null): string[] {
  const out: string[] = [];
  if (path) for (let i = path.indexOf("/"); i >= 0; i = path.indexOf("/", i + 1)) out.push(path.slice(0, i + 1));
  return out;
}

export function buildTree(listing: FileTree, changed: FileDiff[], opened: ReadonlyMap<string, string[] | string>): Dir {
  const root: Dir = { path: "", name: "", dirs: [], files: [], ignored: false, changes: 0 };
  const dirs = new Map([["", root]]);
  const dirAt = (path: string): Dir => {
    let dir = dirs.get(path);
    if (!dir) {
      const cut = path.lastIndexOf("/", path.length - 2) + 1;
      dir = { path, name: path.slice(cut, -1), dirs: [], files: [], ignored: false, changes: 0 };
      dirAt(path.slice(0, cut)).dirs.push(dir);
      dirs.set(path, dir);
    }
    return dir;
  };
  const seen = new Set<string>();
  const addFile = (path: string, diff?: FileDiff, ignored = false) => {
    if (seen.has(path)) return;
    seen.add(path);
    dirAt(path.slice(0, path.lastIndexOf("/") + 1)).files.push({ path, diff, ignored });
  };
  for (const f of changed) {
    addFile(f.path, f);
    for (const dir of parentDirs(f.path)) dirAt(dir).changes++;
  }
  for (const path of listing.files) addFile(path);
  // Opened folders outlive a switch to a view that doesn't read the disk, such as staged or a commit.
  const listed = (dir: string) => listing.ignored.some((d) => d.endsWith("/") && dir.startsWith(d));
  const entries = [...opened].flatMap(([dir, e]) => (typeof e === "string" || !listed(dir) ? [] : e));
  for (const path of [...listing.ignored, ...entries]) {
    if (path.endsWith("/")) dirAt(path).ignored = true;
    else addFile(path, undefined, true);
  }
  const sort = (dir: Dir) => {
    dir.dirs.sort((x, y) => collator.compare(x.name, y.name));
    dir.files.sort((x, y) => collator.compare(x.path, y.path));
    dir.dirs.forEach(sort);
  };
  sort(root);
  return root;
}
