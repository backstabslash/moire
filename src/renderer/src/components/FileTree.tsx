import { type ReactNode, type RefObject, useEffect, useMemo, useState } from "react";
import type { FileDiff, FileStatus, FileTree as Listing } from "../../../shared/types";
import { buildTree, type Dir } from "../model/tree";

const KIND: Record<FileStatus, string> = { added: "A", modified: "M", deleted: "D", renamed: "R", untracked: "U", conflicted: "C", unchanged: "" };
const STAGED = { full: "Staged", partial: "Partly staged", none: "Not staged" };
const INDENT = 12;

export interface ListState {
  active: string | null;
  hitCounts: ReadonlyMap<string, number> | null;
  fresh: { paths: ReadonlySet<string>; at: number } | null;
  activeRef: RefObject<HTMLButtonElement | null>;
  onSelect(path: string): void;
}

export function fileRow(list: ListState, path: string, f: FileDiff | undefined, opts: { depth?: number; ignored?: boolean } = {}) {
  const isFresh = !!f && !!list.fresh?.paths.has(path);
  const isActive = path === list.active;
  const cls = [
    "file",
    isActive && "is-active",
    f?.status === "deleted" && "is-deleted",
    list.hitCounts && !list.hitCounts.has(path) && "no-hits",
    isFresh && "is-fresh",
    f?.noise && "is-noise",
    !f && "is-unchanged",
    opts.ignored && "is-ignored",
  ];
  const title = f
    ? `${f.oldPath ? `${f.oldPath} → ${path}` : path}${f.noise ? `\n${f.noise}, folded` : ""}`
    : `${path}${opts.ignored ? "\nIgnored by git" : "\nNo changes"}`;
  return (
    <button
      key={isFresh ? `${path}:${list.fresh!.at}` : path}
      ref={isActive ? list.activeRef : undefined}
      className={cls.filter(Boolean).join(" ")}
      style={opts.depth !== undefined ? { paddingLeft: 32 + opts.depth * INDENT } : undefined}
      aria-current={isActive}
      title={title}
      onClick={() => list.onSelect(path)}
    >
      {f?.staged && <span className={`st st-${f.staged}`} title={STAGED[f.staged]} />}
      <span className="name">{path.split("/").pop()}</span>
      <span className="kind">{f ? KIND[f.status] : ""}</span>
      <span className="nums">
        {list.hitCounts?.has(path) && (
          <span className="hit-count" title="Search hits">
            {list.hitCounts.get(path)}
          </span>
        )}
        {f?.binary ? (
          <span>bin</span>
        ) : (
          <>
            {!!f?.additions && <span className="s-add">+{f.additions}</span>}
            {!!f?.deletions && <span className="s-del">−{f.deletions}</span>}
          </>
        )}
      </span>
    </button>
  );
}

interface Props {
  root: string;
  listing: Listing;
  changed: FileDiff[];
  list: ListState;
}

export function FileTree({ root, listing, changed, list }: Props) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [opened, setOpened] = useState<ReadonlyMap<string, string[] | string>>(new Map());
  const tree = useMemo(() => buildTree(listing, changed, opened), [listing, changed, opened]);

  useEffect(() => {
    const path = list.active;
    if (!path) return;
    const parents: string[] = [];
    for (let i = path.indexOf("/"); i >= 0; i = path.indexOf("/", i + 1)) parents.push(path.slice(0, i + 1));
    setOpen((cur) => (parents.every((p) => cur.has(p)) ? cur : new Set([...cur, ...parents])));
  }, [list.active]);

  const toggle = (dir: Dir) => {
    const next = new Set(open);
    if (next.delete(dir.path)) return setOpen(next);
    setOpen(next.add(dir.path));
    if (!dir.ignored) return;
    window.moire.listDir(root, dir.path).then(
      (entries) => setOpened((cur) => new Map(cur).set(dir.path, entries)),
      () => setOpened((cur) => new Map(cur).set(dir.path, "Can't read this folder.")),
    );
  };

  const rows: ReactNode[] = [];
  const walk = (dir: Dir, depth: number) => {
    for (const d of dir.dirs) {
      const isOpen = open.has(d.path);
      rows.push(
        <button
          key={d.path}
          className={`tree-dir${d.ignored ? " is-ignored" : ""}`}
          style={{ paddingLeft: 16 + depth * INDENT }}
          aria-expanded={isOpen}
          title={`${d.path}${d.ignored ? "\nIgnored by git" : ""}`}
          onClick={() => toggle(d)}
        >
          <span className="name">{d.name}</span>
          {d.changes > 0 && (
            <span className="tree-count" title={`${d.changes} changed ${d.changes === 1 ? "file" : "files"}`}>
              {d.changes}
            </span>
          )}
        </button>,
      );
      if (!isOpen) continue;
      const error = opened.get(d.path);
      if (typeof error === "string") {
        rows.push(
          <div key={`${d.path}:error`} className="no-match" style={{ paddingLeft: 32 + depth * INDENT }}>
            {error}
          </div>,
        );
      }
      walk(d, depth + 1);
    }
    for (const f of dir.files) rows.push(fileRow(list, f.path, f.diff, { depth, ignored: f.ignored }));
  };
  walk(tree, 0);
  return <>{rows}</>;
}
