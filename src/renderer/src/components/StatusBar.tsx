import { useEffect, useState } from "react";
import type { FileDiff } from "../../../shared/types";
import { type CommandId, COMMANDS, keyLabel } from "../../../shared/keymap";
import { keyText, MAC, useKeymap } from "./Key";
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
  hints?: boolean;
  onCommand(id: CommandId): void;
}

export function StatusBar({ loadedAt, files, error, actions, zoom, hints = true, onCommand }: Props) {
  const keymap = useKeymap();
  const hint = (ids: CommandId[], text: string, run = ids[0]) => {
    const bound = ids.filter((id) => keymap.keys[id].length);
    if (!bound.length) return null;
    const keys = bound.map((id) => keyLabel(keymap, id, MAC));
    const title = bound.map((id) => `${COMMANDS[id].label} (${keyText(keymap, id)})`).join(", ");
    return (
      <button title={title} onClick={() => onCommand(run)}>
        <kbd>{keys.join("") === "12345" ? "1–5" : keys.join(" ")}</kbd>
        {text}
      </button>
    );
  };
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
      {error && (
        <span className="error" title={error}>
          {error}
        </span>
      )}
      <span className="keys">
        {hints && (
          <span className="keys-list">
            {hint(["nextHunk", "prevHunk"], "hunk")}
            {hint(["prevFile", "nextFile"], "file", "nextFile")}
            {hint(["blinkHold"], "blink", "blink")}
            {actions && hint(["stage"], actions === "staged" ? "unstage" : "stage")}
            {actions === "unstaged" && hint(["discard"], "discard")}
            {actions && hint(["undo"], "undo")}
            {hint(["copyMarkdown"], "copy")}
            {hint(["search"], "search")}
            {hint(["openEditor"], "editor")}
            {hint(["fullFile"], "full file")}
            {hint(["layout"], "layout")}
            {hint(["unstaged", "staged", "all", "commit", "branches"], "compare", "compare")}
          </span>
        )}
        {hint(["help"], "all keys")}
      </span>
    </footer>
  );
}
