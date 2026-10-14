import { useEffect, useState } from "react";
import type { FileDiff } from "../../../shared/types";
import { Mark } from "./Mark";

function ago(ms: number) {
  const s = Math.round(ms / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

interface Props {
  loadedAt: number | null;
  files: FileDiff[];
  error: string | null;
  actions: "unstaged" | "staged" | null;
  zoom: number;
}

export function StatusBar({ loadedAt, files, error, actions, zoom }: Props) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(id);
  }, []);

  let adds = 0;
  let dels = 0;
  for (const f of files) {
    adds += f.additions;
    dels += f.deletions;
  }

  return (
    <footer className="status">
      <span className="live">
        <Mark />
        {loadedAt ? `Updated ${ago(Math.max(0, now - loadedAt))}` : "moire"}
      </span>
      {files.length > 0 && (
        <span>
          {files.length} {files.length === 1 ? "file" : "files"}, <span className="s-add">+{adds}</span> <span className="s-del">−{dels}</span>
        </span>
      )}
      {zoom !== 1 && (
        <button className="zoom" title="Reset zoom to 100%" onClick={() => window.moire.resetZoom()}>
          {Math.round(zoom * 100)}%
        </button>
      )}
      {error && <span className="error">{error}</span>}
      <span className="keys">
        <span>
          <kbd>j k</kbd>hunk
        </span>
        <span>
          <kbd>[ ]</kbd>file
        </span>
        <span>
          <kbd>b</kbd>blink
        </span>
        {actions && (
          <>
            <span>
              <kbd>s</kbd>
              {actions === "staged" ? "unstage" : "stage"}
            </span>
            {actions === "unstaged" && (
              <span>
                <kbd>x</kbd>discard
              </span>
            )}
            <span>
              <kbd>u</kbd>undo
            </span>
          </>
        )}
        <span>
          <kbd>c</kbd>copy
        </span>
        <span>
          <kbd>/</kbd>search
        </span>
        <span>
          <kbd>e</kbd>editor
        </span>
        <span>
          <kbd>f</kbd>full file
        </span>
        <span>
          <kbd>v</kbd>layout
        </span>
        <span>
          <kbd>1–5</kbd>compare
        </span>
      </span>
    </footer>
  );
}
