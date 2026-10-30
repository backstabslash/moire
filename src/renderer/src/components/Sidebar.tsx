import { type Dispatch, type MouseEvent, type ReactNode, type RefObject, type SetStateAction, useEffect, useMemo, useRef, useState } from "react";
import type { CompareMode, FileDiff, FileTree as Listing, RepoInfo, RepoState, Upstream } from "../../../shared/types";
import { fuzzyMatch, listFiles, orderPaths } from "../model/files";
import { timeAgo } from "../model/time";
import { parentDirs } from "../model/tree";
import { FolderGlyph } from "./FileGlyph";
import { fileRow, FileTree, type Folders, type ListState } from "./FileTree";
import { Key } from "./Key";
import { Resizer } from "./Resizer";

const MATCH_LIMIT = 500;
const NO_DIRS: ReadonlySet<string> = new Set();
export const SIDE_WIDTH = { initial: 240, min: 180, max: 560 };

const STATES: Record<RepoState, [string, string]> = {
  merging: ["Merging", "A merge is in progress"],
  rebasing: ["Rebasing", "A rebase is in progress"],
  "cherry-picking": ["Cherry-picking", "A cherry-pick is in progress"],
  reverting: ["Reverting", "A revert is in progress"],
  bisecting: ["Bisecting", "A bisect is in progress"],
};

export type FilesView = "changed" | "all";

interface Group {
  dir: string;
  paths: string[];
}

interface ShutFolders {
  root: string;
  active: string | null;
  dirs: ReadonlySet<string>;
}

interface DirHeadProps {
  tip: string;
  shut: boolean;
  files: (FileDiff | undefined)[];
  onToggle(): void;
}

const sameList = (a: string[] | string | undefined, b: string[]) => Array.isArray(a) && a.length === b.length && a.every((p, i) => p === b[i]);

export interface Reveal {
  dir: string;
  at: number;
}

interface Props {
  repo: RepoInfo;
  upstream: Upstream | null;
  view: FilesView;
  onView(view: FilesView): void;
  files: FileDiff[];
  changed: FileDiff[];
  tree: Listing | null;
  refreshTick: number;
  active: string | null;
  hitCounts: ReadonlyMap<string, number> | null;
  fresh: { paths: ReadonlySet<string>; at: number } | null;
  filter: string;
  filterRef: RefObject<HTMLInputElement | null>;
  onFilter(filter: string): void;
  children?: ReactNode;
  onSelect(path: string): void;
  menu: string | null;
  onMenu(path: string, event: MouseEvent): void;
  onSwitchRepo(): void;
  onMode(mode: CompareMode): void;
  reveal: Reveal | null;
  width: number;
  onWidth(width: number): void;
}

function useRelistOpenIgnoredFolders(root: string, folders: Folders, setFolders: Dispatch<SetStateAction<Folders>>, refreshTick: number) {
  useEffect(() => {
    for (const [dir, entries] of folders.opened) {
      if (typeof entries === "string" || !folders.open.has(dir)) continue;
      window.moire.listDir(root, dir).then(
        (next) =>
          setFolders((cur) => (cur.root === root && !sameList(cur.opened.get(dir), next) ? { ...cur, opened: new Map(cur.opened).set(dir, next) } : cur)),
        () => {},
      );
    }
  }, [refreshTick]);
}

export function Sidebar({
  repo,
  upstream,
  view,
  onView,
  files,
  changed,
  tree,
  refreshTick,
  active,
  hitCounts,
  fresh,
  filter,
  filterRef,
  onFilter,
  children,
  onSelect,
  menu,
  onMenu,
  onSwitchRepo,
  onMode,
  reveal,
  width,
  onWidth,
}: Props) {
  const [folders, setFolders] = useState<Folders>({ root: repo.root, active: null, open: new Set(), opened: new Map() });
  if (folders.root !== repo.root || folders.active !== active) {
    const kept = folders.root === repo.root ? folders : { open: new Set<string>(), opened: new Map() };
    const parents = parentDirs(active);
    const open = parents.every((p) => kept.open.has(p)) ? kept.open : new Set([...kept.open, ...parents]);
    setFolders({ root: repo.root, active, open, opened: kept.opened });
  }

  const [revealed, setRevealed] = useState(reveal);
  if (revealed !== reveal) {
    setRevealed(reveal);
    if (reveal) setFolders((cur) => ({ ...cur, open: new Set([...cur.open, ...parentDirs(reveal.dir)]) }));
  }

  const openIgnored = [...folders.opened].flatMap(([dir, entries]) => (typeof entries !== "string" && folders.open.has(dir) ? [dir] : [])).join("\0");
  useEffect(() => {
    void window.moire.watchFolders(repo.root, openIgnored ? openIgnored.split("\0") : []);
  }, [repo.root, openIgnored]);

  useRelistOpenIgnoredFolders(repo.root, folders, setFolders, refreshTick);

  const byPath = useMemo(() => new Map(changed.map((f) => [f.path, f])), [changed]);
  const ignored = useMemo(() => new Set(tree?.ignored), [tree]);
  const allPaths = useMemo(() => {
    if (!tree) return [];
    const paths = new Set([...changed.map((f) => f.path), ...tree.files, ...tree.ignored.filter((p) => !p.endsWith("/"))]);
    return orderPaths([...paths]);
  }, [tree, changed]);
  const matches = useMemo(() => (view === "all" && filter ? allPaths.filter((p) => fuzzyMatch(filter, p)) : null), [view, filter, allPaths]);
  const listed = useMemo(() => (view === "changed" ? files.map((f) => f.path) : (matches ?? [])), [view, files, matches]);

  const suffixes = useMemo(
    () => new Map(view === "changed" ? listFiles(files).flatMap((r) => (r.suffix ? [[r.file.path, r.suffix] as const] : [])) : []),
    [view, files],
  );
  const groups = useMemo(() => {
    const out: Group[] = [];
    for (const path of view === "all" ? listed.slice(0, MATCH_LIMIT) : listed) {
      const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      const last = out[out.length - 1];
      if (last && last.dir === dir) last.paths.push(path);
      else out.push({ dir, paths: [path] });
    }
    return out;
  }, [view, listed]);

  const [shut, setShut] = useState<ShutFolders>({ root: repo.root, active: null, dirs: new Set() });
  if (shut.root !== repo.root || shut.active !== active) {
    const dirs = new Set(shut.root === repo.root ? shut.dirs : []);
    dirs.delete(groups.find((g) => active && g.paths.includes(active))?.dir ?? "");
    setShut({ root: repo.root, active, dirs });
  }
  const shutDirs = filter ? NO_DIRS : shut.dirs;
  const toggleDir = (dir: string) =>
    !filter &&
    setShut((cur) => {
      const dirs = new Set(cur.dirs);
      if (!dirs.delete(dir)) dirs.add(dir);
      return { ...cur, dirs };
    });

  const activeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [active, view]);

  const navRef = useRef<HTMLElement>(null);
  const toScrollTo = useRef<Reveal | null>(null);
  useEffect(() => {
    toScrollTo.current = reveal;
  }, [reveal]);
  useEffect(() => {
    const dir = view === "all" ? toScrollTo.current?.dir : undefined;
    const row = dir && navRef.current?.querySelector(`[data-dir="${CSS.escape(dir)}"]`);
    if (!row) return;
    toScrollTo.current = null;
    row.scrollIntoView({ block: "center" });
  });

  useEffect(() => {
    let clicked = false;
    const down = (e: globalThis.MouseEvent) => {
      clicked = !!navRef.current?.contains(e.target as Node);
    };
    const key = (e: KeyboardEvent) => {
      const nav = navRef.current;
      const inside = !!nav?.contains(document.activeElement);
      if (!nav || (e.key !== "ArrowDown" && e.key !== "ArrowUp") || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (!inside && (!clicked || document.activeElement?.closest("input, select, textarea, .picker-pop"))) return;
      const rows = [...nav.querySelectorAll<HTMLButtonElement>(".file")];
      const at = rows.findIndex((b) => b.getAttribute("aria-current") === "true");
      const next = rows[at < 0 ? 0 : at + (e.key === "ArrowDown" ? 1 : -1)];
      e.preventDefault();
      if (!next) return;
      next.click();
      if (inside) next.focus();
    };
    window.addEventListener("mousedown", down);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", down);
      window.removeEventListener("keydown", key);
    };
  }, []);

  const list: ListState = { active, hitCounts, fresh, activeRef, onSelect, menu, onMenu };
  const total = view === "changed" ? changed.length : allPaths.length;
  const count = filter && (view === "changed" || tree) ? `${listed.length} of ${total}` : "";

  return (
    <aside className="sidebar">
      <Resizer className="side-resize" label="Resize the file list" width={width} limits={SIDE_WIDTH} onWidth={onWidth} />
      <div className="side-head">
        <span className="repo-line">
          <button className="repo" data-tip={`${repo.root}${repo.branch ? `\n${repo.branch}` : ""}\nClick to open another repository`} onClick={onSwitchRepo}>
            <span>{repo.name}</span>
            <small>{repo.folder ? "folder" : (repo.branch ?? repo.head ?? "no commits")}</small>
          </button>
          <RepoBadges repo={repo} up={upstream} onMode={onMode} />
        </span>
        <span className="side-count">
          <span className="count">{count}</span>
        </span>
      </div>
      <div className="seg side-view" role="group" aria-label="Files shown">
        <button
          aria-pressed={view === "changed"}
          aria-disabled={repo.folder}
          data-tip={repo.folder ? "Changes need a git repository" : undefined}
          onClick={() => onView("changed")}
        >
          Changed
        </button>
        <button aria-pressed={view === "all"} onClick={() => onView("all")}>
          All files
          <Key id="allFiles" />
        </button>
      </div>
      <input
        ref={filterRef}
        className="file-filter"
        value={filter}
        placeholder="Filter files"
        aria-label="Filter files"
        spellCheck={false}
        onChange={(e) => onFilter(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            onFilter("");
            e.currentTarget.blur();
          } else if (e.key === "Enter") {
            if (listed[0]) onSelect(listed[0]);
            e.currentTarget.blur();
          }
        }}
      />
      <nav ref={navRef} className="files" aria-label={view === "changed" ? "Changed files" : "All files"}>
        {view === "all" && !filter
          ? tree && <FileTree listing={tree} changed={changed} list={list} folders={folders} onFolders={setFolders} />
          : groups.map((g) => (
              <div className="group" key={g.dir}>
                {g.dir && <DirHead tip={g.dir} shut={shutDirs.has(g.dir)} files={g.paths.map((p) => byPath.get(p))} onToggle={() => toggleDir(g.dir)} />}
                {!(g.dir && shutDirs.has(g.dir)) &&
                  g.paths.map((path) => fileRow(list, path, byPath.get(path), { ignored: ignored.has(path), suffix: suffixes.get(path) }))}
              </div>
            ))}
        {view === "all" && listed.length > MATCH_LIMIT && <div className="no-match">{listed.length - MATCH_LIMIT} more. Narrow the filter to see them.</div>}
        {filter && !listed.length && <div className="no-match">No files match.</div>}
      </nav>
      {children}
    </aside>
  );
}

function fetched(at: number | null): string {
  if (at === null) return "Never fetched.";
  return `As of the last fetch, ${timeAgo(at)}.`;
}

function DirHead({ tip, shut, files, onToggle }: DirHeadProps) {
  const known = files.filter((f) => !!f);
  const adds = known.reduce((n, f) => n + f.additions, 0);
  const dels = known.reduce((n, f) => n + f.deletions, 0);
  return (
    <button className="dir" aria-expanded={!shut} data-tip={tip} onClick={onToggle}>
      <FolderGlyph open={!shut} />
      <span className="name">
        <bdi>{tip}</bdi>
      </span>
      {shut && (
        <span className="dir-sum">
          <span>{files.length}</span>
          {!!adds && <span className="s-add">+{adds}</span>}
          {!!dels && <span className="s-del">−{dels}</span>}
        </span>
      )}
    </button>
  );
}

function RepoBadges({ repo, up, onMode }: { repo: RepoInfo; up: Upstream | null; onMode(mode: CompareMode): void }) {
  const plural = (n: number) => `${n} ${n === 1 ? "commit" : "commits"}`;
  const review = (n: number) => `Click to review ${n === 1 ? "it" : "them"}.`;
  return (
    <>
      {up && repo.branch && (up.ahead > 0 || up.behind > 0) && (
        <span className="sync">
          {up.ahead > 0 && (
            <button
              data-tip={`${plural(up.ahead)} to push to ${up.name}. ${review(up.ahead)}\n${fetched(up.fetchedAt)}`}
              onClick={() => onMode({ kind: "branches", base: up.name, head: repo.branch! })}
            >
              ↑{up.ahead}
            </button>
          )}
          {up.behind > 0 && (
            <button
              data-tip={`${plural(up.behind)} on ${up.name} to pull. ${review(up.behind)}\n${fetched(up.fetchedAt)}`}
              onClick={() => onMode({ kind: "branches", base: repo.branch!, head: up.name })}
            >
              ↓{up.behind}
            </button>
          )}
        </span>
      )}
      {repo.state ? (
        <span className="repo-state" data-tip={STATES[repo.state][1]}>
          {STATES[repo.state][0]}
        </span>
      ) : (
        !repo.branch &&
        repo.head && (
          <span className="repo-state" data-tip={`HEAD is detached at ${repo.head}`}>
            Detached
          </span>
        )
      )}
    </>
  );
}
