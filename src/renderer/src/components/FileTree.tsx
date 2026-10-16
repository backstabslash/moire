import { type Dispatch, type MouseEvent, type ReactNode, type RefObject, type SetStateAction, useMemo } from "react";
import type { FileDiff, FileStatus, FileTree as Listing } from "../../../shared/types";
import { modeNote } from "../model/modes";
import { buildTree, type Dir } from "../model/tree";

const KIND: Record<FileStatus, [string, string]> = {
  added: ["A", "Added"],
  modified: ["M", "Modified"],
  deleted: ["D", "Deleted"],
  renamed: ["R", "Renamed"],
  untracked: ["U", "Untracked"],
  conflicted: ["C", "Conflict"],
  unchanged: ["", ""],
};
const MARKS = { full: "Staged", partial: "Partly staged", changed: "Staged, then changed again" };
const INDENT = 12;

export interface ListState {
  active: string | null;
  hitCounts: ReadonlyMap<string, number> | null;
  fresh: { paths: ReadonlySet<string>; at: number } | null;
  activeRef: RefObject<HTMLButtonElement | null>;
  onSelect(path: string): void;
  menu: string | null;
  onMenu(path: string, event: MouseEvent): void;
}

export function fileRow(
  list: ListState,
  path: string,
  f: FileDiff | undefined,
  opts: { depth?: number; ignored?: boolean; hint?: string; suffix?: string } = {},
) {
  const name = path.split("/").pop()!;
  const isFresh = !!f && !!list.fresh?.paths.has(path);
  const isActive = path === list.active;
  const cls = [
    "file",
    isActive && "is-active",
    path === list.menu && "is-menu",
    f?.status === "deleted" && "is-deleted",
    list.hitCounts && !list.hitCounts.has(path) && "no-hits",
    isFresh && "is-fresh",
    f?.noise && "is-noise",
    f?.staged === "full" && "is-staged",
    !f && "is-unchanged",
    opts.ignored && "is-ignored",
    opts.suffix && "sib",
  ];
  const mode = f && modeNote(f);
  const mark = f?.changedSinceStaged ? "changed" : f?.staged === "full" || f?.staged === "partial" ? f.staged : null;
  const title = f
    ? `${f.oldPath ? `${f.oldPath} → ${path}` : path}${mode ? `\n${mode.words[0].toUpperCase()}${mode.words.slice(1)}` : ""}${f.noise ? `\n${f.noise}, folded` : ""}`
    : `${path}${opts.ignored ? "\nIgnored by git" : "\nNo changes"}`;
  return (
    <button
      key={isFresh ? `${path}:${list.fresh!.at}` : path}
      ref={isActive ? list.activeRef : undefined}
      className={cls.filter(Boolean).join(" ")}
      style={opts.depth !== undefined ? { paddingLeft: 32 + opts.depth * INDENT } : undefined}
      aria-current={isActive}
      title={title}
      data-path={path}
      draggable={f?.status !== "deleted"}
      onClick={() => list.onSelect(path)}
      onContextMenu={(e) => list.onMenu(path, e)}
    >
      <span className="name" data-hint={opts.hint}>
        {opts.suffix ? (
          <>
            <span className="tie" />
            <span className="stem">{name.slice(0, name.length - opts.suffix.length)}</span>
            {opts.suffix}
          </>
        ) : (
          name
        )}
      </span>
      <span className="kind" title={f ? KIND[f.status][1] : undefined}>
        {f ? KIND[f.status][0] : ""}
      </span>
      <span className="nums">
        {list.hitCounts?.has(path) && (
          <span className="hit-count" title="Search hits">
            {list.hitCounts.get(path)}
          </span>
        )}
        {mode && (
          <span className="mode-tag" title={mode.words}>
            {mode.tag}
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
      {mark && <Mark state={mark} />}
    </button>
  );
}

function Mark({ state }: { state: keyof typeof MARKS }) {
  return state === "changed" ? (
    <span className="mark mark-changed" title={MARKS[state]} />
  ) : (
    <svg className={`mark mark-${state}`} viewBox="0 0 12 12" aria-label={MARKS[state]}>
      <title>{MARKS[state]}</title>
      {state === "full" ? (
        <path d="M2 6.4l2.6 2.6L10 3.4" />
      ) : (
        <>
          <circle cx="6" cy="6" r="4" />
          <path className="half" d="M6 2a4 4 0 0 0 0 8z" />
        </>
      )}
    </svg>
  );
}

export interface Folders {
  root: string;
  active: string | null;
  open: ReadonlySet<string>;
  opened: ReadonlyMap<string, string[] | string>;
}

interface Props {
  listing: Listing;
  changed: FileDiff[];
  list: ListState;
  folders: Folders;
  onFolders: Dispatch<SetStateAction<Folders>>;
}

export function FileTree({ listing, changed, list, folders, onFolders }: Props) {
  const { root, open, opened } = folders;
  const tree = useMemo(() => buildTree(listing, changed, opened), [listing, changed, opened]);

  const toggle = (dir: Dir) => {
    const next = new Set(open);
    if (next.delete(dir.path)) return onFolders((cur) => ({ ...cur, open: next }));
    onFolders((cur) => ({ ...cur, open: next.add(dir.path) }));
    if (!dir.ignored) return;
    const store = (entries: string[] | string) =>
      onFolders((cur) => (cur.root === root ? { ...cur, opened: new Map(cur.opened).set(dir.path, entries) } : cur));
    window.moire.listDir(root, dir.path).then(store, () => store("Can't read this folder."));
  };

  const rows: ReactNode[] = [];
  const walk = (dir: Dir, depth: number) => {
    for (const d of dir.dirs) {
      const isOpen = open.has(d.path);
      rows.push(
        <button
          key={d.path}
          className={`tree-dir${d.ignored ? " is-ignored" : ""}${d.path === list.menu ? " is-menu" : ""}`}
          style={{ paddingLeft: 16 + depth * INDENT }}
          aria-expanded={isOpen}
          data-dir={d.path}
          title={`${d.path}${d.ignored ? "\nIgnored by git" : ""}`}
          onClick={() => toggle(d)}
          onContextMenu={(e) => list.onMenu(d.path, e)}
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
