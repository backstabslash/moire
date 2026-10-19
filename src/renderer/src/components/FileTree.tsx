import { type CSSProperties, type Dispatch, type MouseEvent, type ReactNode, type RefObject, type SetStateAction, useMemo } from "react";
import type { FileDiff, FileStatus, FileTree as Listing } from "../../../shared/types";
import { modeNote } from "../model/modes";
import { buildTree, type Dir } from "../model/tree";
import { Registered } from "./Mark";

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
const depthStyle = (depth: number) => ({ "--depth": depth }) as CSSProperties;

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
    opts.depth !== undefined && "in-tree",
  ];
  const mode = f && modeNote(f);
  const mark = f?.changedSinceStaged ? "changed" : f?.staged === "full" || f?.staged === "partial" ? f.staged : null;
  const title = f
    ? [
        f.oldPath ? `${f.oldPath} → ${path}` : path,
        [KIND[f.status][1], mark && MARKS[mark].toLowerCase()].filter(Boolean).join(", "),
        mode && `${mode.words[0].toUpperCase()}${mode.words.slice(1)}`,
        f.noise && `${f.noise}, folded`,
      ]
        .filter(Boolean)
        .join("\n")
    : `${path}${opts.ignored ? "\nIgnored by git" : "\nNo changes"}`;
  return (
    <button
      key={isFresh ? `${path}:${list.fresh!.at}` : path}
      ref={isActive ? list.activeRef : undefined}
      className={cls.filter(Boolean).join(" ")}
      style={opts.depth !== undefined ? depthStyle(opts.depth) : undefined}
      aria-current={isActive}
      data-tip={title}
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
      <span className="kind">{f ? KIND[f.status][0] : ""}</span>
      <span className="nums">
        {list.hitCounts?.has(path) && (
          <span className="hit-count" title="Search hits">
            {list.hitCounts.get(path)}
          </span>
        )}
        {mode && <span className="mode-tag">{mode.tag}</span>}
        {f?.binary ? (
          <span>bin</span>
        ) : (
          <>
            {!!f?.additions && <span className="s-add">+{f.additions}</span>}
            {!!f?.deletions && <span className="s-del">−{f.deletions}</span>}
          </>
        )}
      </span>
      {f?.staged === "partial" && <Registered state="partial" label={MARKS.partial} />}
    </button>
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

  const toggle = (singleChildRun: Dir[], isOpen: boolean) => {
    const next = new Set(open);
    for (const d of singleChildRun) next[isOpen ? "delete" : "add"](d.path);
    onFolders((cur) => ({ ...cur, open: next }));
    const dir = singleChildRun[singleChildRun.length - 1];
    if (isOpen || !dir.ignored) return;
    const store = (entries: string[] | string) =>
      onFolders((cur) => (cur.root === root ? { ...cur, opened: new Map(cur.opened).set(dir.path, entries) } : cur));
    window.moire.listDir(root, dir.path).then(store, () => store("Can't read this folder."));
  };

  const rows: ReactNode[] = [];
  const walk = (dir: Dir, depth: number) => {
    for (const top of dir.dirs) {
      const singleChildRun = [top];
      for (let c = top; c.dirs.length === 1 && !c.files.length && !c.ignored && !c.dirs[0].ignored;) singleChildRun.push((c = c.dirs[0]));
      const d = singleChildRun[singleChildRun.length - 1];
      const isOpen = singleChildRun.every((c) => open.has(c.path));
      rows.push(
        <button
          key={d.path}
          className={`tree-dir${d.ignored ? " is-ignored" : ""}${d.path === list.menu ? " is-menu" : ""}`}
          style={depthStyle(depth)}
          aria-expanded={isOpen}
          data-dir={d.path}
          data-tip={`${d.path}${d.ignored ? "\nIgnored by git" : ""}`}
          onClick={() => toggle(singleChildRun, isOpen)}
          onContextMenu={(e) => list.onMenu(d.path, e)}
        >
          <span className="name">
            <bdi>
              {singleChildRun.slice(0, -1).map((c) => (
                <span key={c.path} className="tree-seg" data-dir={c.path}>
                  {c.name}
                  <i>/</i>
                </span>
              ))}
              {d.name}
              <i>/</i>
            </bdi>
          </span>
          {d.changes > 0 && !isOpen && (
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
          <div key={`${d.path}:error`} className="no-match tree-note" style={depthStyle(depth + 1)}>
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
