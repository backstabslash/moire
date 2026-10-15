import { useEffect, useMemo, useRef, useState } from "react";
import { fuzzyMatch } from "../model/files";

interface Props {
  current: string | null;
  onOpen(path: string): void;
  onBrowse(): void;
  onClose(): void;
}

export function RepoPicker({ current, onOpen, onBrowse, onClose }: Props) {
  const [recent, setRecent] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [hot, setHot] = useState(0);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    window.moire.recentRepos().then(
      (list) => setRecent(list.filter((r) => r !== current)),
      () => setRecent([]),
    );
  }, [current]);

  useEffect(() => {
    const away = (event: MouseEvent) => {
      if (!popRef.current?.contains(event.target as Node)) onClose();
    };
    window.addEventListener("mousedown", away);
    return () => window.removeEventListener("mousedown", away);
  }, [onClose]);

  const shown = useMemo(() => recent.filter((r) => fuzzyMatch(query, r)), [recent, query]);
  const choose = (i: number) => (i < shown.length ? onOpen(shown[i]) : onBrowse());

  return (
    <div className="picker-pop repo-pop" ref={popRef}>
      <input
        autoFocus
        value={query}
        placeholder="Open a recent repository"
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
        {shown.map((path, i) => (
          <button key={path} role="option" aria-selected={false} className={i === hot ? "is-hot" : ""} onMouseEnter={() => setHot(i)} onClick={() => choose(i)}>
            {path.split("/").pop()}
            <small>{path}</small>
          </button>
        ))}
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
