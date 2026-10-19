import { type Dispatch, type MouseEvent, type ReactNode, type RefObject, type SetStateAction, useEffect, useMemo, useRef, useState } from "react";
import type { CompareMode, FileDiff, FileTree as Listing, RepoInfo, RepoState, Upstream } from "../../../shared/types";
import { fuzzyMatch, orderPaths } from "../model/files";
import { type Grouping, type PairedGroup, pairFiles } from "../model/paired";
import { parentDirs } from "../model/tree";
import { fileRow, FileTree, type Folders, type ListState } from "./FileTree";
import { Key, keyText, useKeymap } from "./Key";

const MATCH_LIMIT = 500;
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

const sameList = (a: string[] | string | undefined, b: string[]) => Array.isArray(a) && a.length === b.length && a.every((p, i) => p === b[i]);

interface Props {
  repo: RepoInfo;
  upstream: Upstream | null;
  view: FilesView;
  onView(view: FilesView): void;
  grouping: Grouping;
  onGrouping(grouping: Grouping): void;
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
  grouping,
  onGrouping,
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

  const paired = useMemo(() => (view === "changed" && grouping === "paired" ? pairFiles(files, changed) : null), [view, grouping, files, changed]);
  const groups = useMemo(() => {
    const out: Group[] = [];
    if (paired) return out;
    for (const path of view === "all" ? listed.slice(0, MATCH_LIMIT) : listed) {
      const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      const last = out[out.length - 1];
      if (last && last.dir === dir) last.paths.push(path);
      else out.push({ dir, paths: [path] });
    }
    return out;
  }, [view, listed, paired]);
  const groupKey = keyText(useKeymap(), "grouping");

  const activeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [active, view]);

  const navRef = useRef<HTMLElement>(null);
  useEffect(() => {
    let clicked = false;
    const down = (e: globalThis.MouseEvent) => {
      clicked = !!navRef.current?.contains(e.target as Node);
    };
    const key = (e: KeyboardEvent) => {
      const nav = navRef.current;
      const inside = !!nav?.contains(document.activeElement);
      if (!nav || (e.key !== "ArrowDown" && e.key !== "ArrowUp") || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (!inside && (!clicked || document.activeElement?.closest("input, select, textarea"))) return;
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

  const marks = changed.some((f) => f.staged === "partial");
  const list: ListState = { active, hitCounts, fresh, activeRef, onSelect, menu, onMenu };
  const total = view === "changed" ? changed.length : allPaths.length;
  const count = filter && (view === "changed" || tree) ? `${listed.length} of ${total}` : "";

  return (
    <aside className="sidebar">
      <Resizer width={width} onWidth={onWidth} />
      <div className="side-head">
        <span className="repo-line">
          <button className="repo" data-tip={`${repo.root}${repo.branch ? `\n${repo.branch}` : ""}\nClick to open another repository`} onClick={onSwitchRepo}>
            <span>{repo.name}</span>
            <small>{repo.branch ?? repo.head ?? "no commits"}</small>
          </button>
          <RepoBadges repo={repo} up={upstream} onMode={onMode} />
        </span>
        <span className="side-count">
          <span className="count">{count}</span>
          {view === "changed" && (
            <button
              className="grouping"
              title={`${grouping === "paired" ? "Paired: grouped by module, with tests and styles under their source" : "By folder"}\nClick or press ${groupKey} to switch`}
              onClick={() => onGrouping(grouping === "paired" ? "folder" : "paired")}
            >
              {grouping === "paired" ? "Paired" : "By folder"}
            </button>
          )}
        </span>
      </div>
      <div className="seg side-view" role="group" aria-label="Files shown">
        <button aria-pressed={view === "changed"} onClick={() => onView("changed")}>
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
      <nav ref={navRef} className={`files${marks ? " with-marks" : ""}`} aria-label={view === "changed" ? "Changed files" : "All files"}>
        {view === "all" && !filter
          ? tree && <FileTree listing={tree} changed={changed} list={list} folders={folders} onFolders={setFolders} />
          : groups.map((g) => (
              <div className="group" key={g.dir}>
                {g.dir && (
                  <div className="dir" data-tip={g.dir}>
                    <bdi>{g.dir}</bdi>
                  </div>
                )}
                {g.paths.map((path) => fileRow(list, path, byPath.get(path), { ignored: ignored.has(path) }))}
              </div>
            ))}
        {paired && <PairedList groups={paired} list={list} />}
        {view === "all" && listed.length > MATCH_LIMIT && <div className="no-match">{listed.length - MATCH_LIMIT} more. Narrow the filter to see them.</div>}
        {filter && !listed.length && <div className="no-match">No files match.</div>}
      </nav>
      {children}
    </aside>
  );
}

const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["day", 86400],
  ["hour", 3600],
  ["minute", 60],
];

function fetched(at: number | null): string {
  if (at === null) return "Never fetched.";
  const s = (Date.now() - at) / 1000;
  const [unit, size] = UNITS.find(([, size]) => s >= size) ?? ["second", 1];
  return `As of the last fetch, ${unit === "second" ? "just now" : relative.format(-Math.round(s / size), unit)}.`;
}

function PairedList({ groups, list }: { groups: PairedGroup[]; list: ListState }) {
  return groups.map((g) => (
    <div className="group" key={g.tier ? g.label : g.folders[0]}>
      {g.tier ? (
        <div className="tier">{g.label}</div>
      ) : (
        <div className="dir module" data-tip={g.folders.join("\n")}>
          <bdi>{g.label}</bdi>
        </div>
      )}
      {g.rows.map((r) =>
        "slot" in r ? (
          <div className="slot-empty" key={`slot:${r.lead}`} data-tip={`No test change for ${r.lead.split("/").pop()}`}>
            <span className="tie" />
            {r.slot}
          </div>
        ) : (
          fileRow(list, r.file.path, r.file, { hint: r.hint, suffix: r.suffix })
        ),
      )}
    </div>
  ));
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
              title={`${plural(up.ahead)} to push to ${up.name}. ${review(up.ahead)}\n${fetched(up.fetchedAt)}`}
              onClick={() => onMode({ kind: "branches", base: up.name, head: repo.branch! })}
            >
              ↑{up.ahead}
            </button>
          )}
          {up.behind > 0 && (
            <button
              title={`${plural(up.behind)} on ${up.name} to pull. ${review(up.behind)}\n${fetched(up.fetchedAt)}`}
              onClick={() => onMode({ kind: "branches", base: repo.branch!, head: up.name })}
            >
              ↓{up.behind}
            </button>
          )}
        </span>
      )}
      {repo.state ? (
        <span className="repo-state" title={STATES[repo.state][1]}>
          {STATES[repo.state][0]}
        </span>
      ) : (
        !repo.branch &&
        repo.head && (
          <span className="repo-state" title={`HEAD is detached at ${repo.head}`}>
            Detached
          </span>
        )
      )}
    </>
  );
}

function Resizer({ width, onWidth }: { width: number; onWidth(width: number): void }) {
  const drag = useRef<{ x: number; width: number } | null>(null);
  return (
    <div
      className="side-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the file list"
      aria-valuenow={width}
      title="Drag to resize, double-click to reset"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, width };
      }}
      onPointerMove={(e) => {
        const from = drag.current;
        if (from) onWidth(Math.round(Math.min(SIDE_WIDTH.max, Math.max(SIDE_WIDTH.min, from.width + e.clientX - from.x))));
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
      onDoubleClick={() => onWidth(SIDE_WIDTH.initial)}
    />
  );
}
