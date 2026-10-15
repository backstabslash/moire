import { type ReactNode, type RefObject, useEffect, useMemo, useRef } from "react";
import type { FileDiff, FileTree as Listing, RepoInfo } from "../../../shared/types";
import { fuzzyMatch, orderPaths } from "../model/files";
import { fileRow, FileTree, type ListState } from "./FileTree";

const MATCH_LIMIT = 500;

export type FilesView = "changed" | "all";

interface Group {
  dir: string;
  paths: string[];
}

interface Props {
  repo: RepoInfo;
  view: FilesView;
  onView(view: FilesView): void;
  files: FileDiff[];
  changed: FileDiff[];
  tree: Listing | null;
  active: string | null;
  hitCounts: ReadonlyMap<string, number> | null;
  fresh: { paths: ReadonlySet<string>; at: number } | null;
  filter: string;
  filterRef: RefObject<HTMLInputElement | null>;
  onFilter(filter: string): void;
  children?: ReactNode;
  onSelect(path: string): void;
  onSwitchRepo(): void;
}

export function Sidebar({
  repo,
  view,
  onView,
  files,
  changed,
  tree,
  active,
  hitCounts,
  fresh,
  filter,
  filterRef,
  onFilter,
  children,
  onSelect,
  onSwitchRepo,
}: Props) {
  const byPath = useMemo(() => new Map(changed.map((f) => [f.path, f])), [changed]);
  const ignored = useMemo(() => new Set(tree?.ignored), [tree]);
  const allPaths = useMemo(() => {
    if (!tree) return [];
    const paths = new Set([...changed.map((f) => f.path), ...tree.files, ...tree.ignored.filter((p) => !p.endsWith("/"))]);
    return orderPaths([...paths]);
  }, [tree, changed]);
  const matches = useMemo(() => (view === "all" && filter ? allPaths.filter((p) => fuzzyMatch(filter, p)) : null), [view, filter, allPaths]);
  const listed = useMemo(() => (view === "changed" ? files.map((f) => f.path) : (matches ?? [])), [view, files, matches]);

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

  const activeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [active, view]);

  const list: ListState = { active, hitCounts, fresh, activeRef, onSelect };
  const total = view === "changed" ? changed.length : allPaths.length;
  const count = view === "all" && !tree ? "" : filter ? `${listed.length} of ${total}` : `${total} ${total === 1 ? "file" : "files"}`;

  return (
    <aside className="sidebar">
      <div className="side-head">
        <button className="repo" title={`${repo.root}\nClick to open another repository`} onClick={onSwitchRepo}>
          {repo.name}
          <small>{repo.branch ?? repo.head ?? "no commits"}</small>
        </button>
        <span className="count">{count}</span>
      </div>
      <div className="seg side-view" role="group" aria-label="Files shown">
        <button aria-pressed={view === "changed"} onClick={() => onView("changed")}>
          Changed
        </button>
        <button aria-pressed={view === "all"} onClick={() => onView("all")}>
          All files<kbd>a</kbd>
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
      <nav className="files" aria-label={view === "changed" ? "Changed files" : "All files"}>
        {view === "all" && !filter
          ? tree && <FileTree root={repo.root} listing={tree} changed={changed} list={list} />
          : groups.map((g) => (
              <div className="group" key={g.dir}>
                {g.dir && (
                  <div className="dir" title={g.dir}>
                    <bdi>{g.dir}</bdi>
                  </div>
                )}
                {g.paths.map((path) => fileRow(list, path, byPath.get(path), { ignored: ignored.has(path) }))}
              </div>
            ))}
        {view === "all" && listed.length > MATCH_LIMIT && <div className="no-match">{listed.length - MATCH_LIMIT} more. Narrow the filter to see them.</div>}
        {filter && !listed.length && <div className="no-match">No files match.</div>}
      </nav>
      {children}
    </aside>
  );
}
