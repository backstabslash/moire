import { type ReactNode, type RefObject, useEffect, useMemo, useRef } from "react";
import type { FileDiff, FileStatus, RepoInfo } from "../../../shared/types";

const KIND: Record<FileStatus, string> = { added: "A", modified: "M", deleted: "D", renamed: "R", untracked: "U", conflicted: "C" };
const STAGED = { full: "Staged", partial: "Partly staged", none: "Not staged" };

interface Group {
  dir: string;
  files: FileDiff[];
}

interface Props {
  repo: RepoInfo;
  // the files the filter lets through
  files: FileDiff[];
  total: number;
  active: string | null;
  // search hits per file while searching
  hitCounts: ReadonlyMap<string, number> | null;
  fresh: { paths: ReadonlySet<string>; at: number } | null;
  filter: string;
  filterRef: RefObject<HTMLInputElement | null>;
  onFilter(filter: string): void;
  // shown under the file list, like the commit box
  children?: ReactNode;
  onSelect(path: string): void;
  onSwitchRepo(): void;
}

export function Sidebar({ repo, files, total, active, hitCounts, fresh, filter, filterRef, onFilter, children, onSelect, onSwitchRepo }: Props) {
  const groups = useMemo(() => {
    const out: Group[] = [];
    for (const f of files) {
      const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "";
      const last = out[out.length - 1];
      if (last && last.dir === dir) last.files.push(f);
      else out.push({ dir, files: [f] });
    }
    return out;
  }, [files]);

  const activeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [active]);

  return (
    <aside className="sidebar">
      <div className="side-head">
        <button className="repo" title={`${repo.root}\nClick to open another repository`} onClick={onSwitchRepo}>
          {repo.name}
          <small>{repo.branch ?? repo.head ?? "no commits"}</small>
        </button>
        <span className="count">
          {filter ? `${files.length} of ${total}` : `${total} ${total === 1 ? "file" : "files"}`}
        </span>
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
            if (files[0]) onSelect(files[0].path);
            e.currentTarget.blur();
          }
        }}
      />
      <nav className="files" aria-label="Changed files">
        {groups.map((g) => (
          <div className="group" key={g.dir}>
            {g.dir && (
              <div className="dir" title={g.dir}>
                <bdi>{g.dir}</bdi>
              </div>
            )}
            {g.files.map((f) => {
              const isFresh = !!fresh?.paths.has(f.path);
              return (
                <button
                  // a new key restarts the flash when the same file changes again
                  key={isFresh ? `${f.path}:${fresh!.at}` : f.path}
                  ref={f.path === active ? activeRef : undefined}
                  className={`file${f.path === active ? " is-active" : ""}${f.status === "deleted" ? " is-deleted" : ""}${hitCounts && !hitCounts.has(f.path) ? " no-hits" : ""}${isFresh ? " is-fresh" : ""}${f.noise ? " is-noise" : ""}`}
                  aria-current={f.path === active}
                  title={`${f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}${f.noise ? `\n${f.noise}, folded` : ""}`}
                  onClick={() => onSelect(f.path)}
                >
                  {f.staged && <span className={`st st-${f.staged}`} title={STAGED[f.staged]} />}
                  <span className="name">{f.path.split("/").pop()}</span>
                  <span className="kind">{KIND[f.status]}</span>
                  <span className="nums">
                    {hitCounts?.has(f.path) && <span className="hit-count" title="Search hits">{hitCounts.get(f.path)}</span>}
                    {f.binary ? (
                      <span>bin</span>
                    ) : (
                      <>
                        {f.additions > 0 && <span className="s-add">+{f.additions}</span>}
                        {f.deletions > 0 && <span className="s-del">−{f.deletions}</span>}
                      </>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        ))}
        {filter && !files.length && <div className="no-match">No files match.</div>}
      </nav>
      {children}
    </aside>
  );
}
