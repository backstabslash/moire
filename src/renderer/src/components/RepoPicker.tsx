import { useEffect, useMemo, useRef, useState } from "react";
import type { Worktree } from "../../../shared/types";
import { fuzzyMatch } from "../model/files";

interface Props {
  current: string | null;
  onOpen(path: string): void;
  onBrowse(): void;
  onClose(): void;
}

export function RepoPicker({ current, onOpen, onBrowse, onClose }: Props) {
  const [recent, setRecent] = useState<string[]>([]);
  const [trees, setTrees] = useState<Worktree[]>([]);
  const [query, setQuery] = useState("");
  const [hot, setHot] = useState(0);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    window.moire.recentRepos().then(
      (list) => setRecent(list.filter((r) => r !== current)),
      () => setRecent([]),
    );
    if (current) {
      window.moire.worktrees(current).then(setTrees, () => setTrees([]));
    }
  }, [current]);

  useEffect(() => {
    const away = (event: MouseEvent) => {
      if (!popRef.current?.contains(event.target as Node)) onClose();
    };
    window.addEventListener("mousedown", away);
    return () => window.removeEventListener("mousedown", away);
  }, [onClose]);

  const others = useMemo(() => trees.filter((t) => t.path !== current && fuzzyMatch(query, t.path)), [trees, current, query]);
  const worktreePaths = useMemo(() => new Set(trees.map((t) => t.path)), [trees]);
  const shown = useMemo(
    () => [...others.map((t) => t.path), ...recent.filter((r) => !worktreePaths.has(r) && fuzzyMatch(query, r))],
    [others, recent, worktreePaths, query],
  );
  const choose = (i: number) => (i < shown.length ? onOpen(shown[i]) : onBrowse());

  return (
    <div className="picker-pop repo-pop" ref={popRef}>
      <input
        autoFocus
        value={query}
        placeholder={others.length ? "Open a worktree or recent repository" : "Open a recent repository"}
        aria-label="Filter recent repositories"
        spellCheck={false}
        onChange={(e) => {
          setQuery(e.target.value);
          setHot(0);
        }}
        onKeyDown={(e) => {
          const last = shown.length;
          if (e.key === "ArrowDown") setHot((h) => Math.min(last, h + 1));
          else if (e.key === "ArrowUp") setHot((h) => Math.max(0, h - 1));
          else if (e.key === "Enter") choose(hot);
          else if (e.key === "Escape") onClose();
          else return;
          e.preventDefault();
        }}
      />
      <div role="listbox" aria-label="Recent repositories">
        {shown.map((path, i) => {
          const tree = i < others.length ? others[i] : null;
          return (
            <button
              key={path}
              role="option"
              aria-selected={false}
              className={i === hot ? "is-hot" : ""}
              onMouseEnter={() => setHot(i)}
              onClick={() => choose(i)}
            >
              {path.split("/").pop()}
              {tree && <span className="repo-tree">{[tree.branch ?? "detached", tree.changes ? `${tree.changes} changed` : "clean"].join(" · ")}</span>}
              <small>{path}</small>
            </button>
          );
        })}
        {others.length > 0 && others.length < shown.length && <div className="sep" />}
        <div className="sep" />
        <button
          role="option"
          aria-selected={false}
          className={hot === shown.length ? "is-hot" : ""}
          onMouseEnter={() => setHot(shown.length)}
          onClick={onBrowse}
        >
          Browse…
          <small>Pick a folder</small>
        </button>
      </div>
    </div>
  );
}
