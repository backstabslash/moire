import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CommandId } from "../../../shared/keymap";
import type { FileDiff, LineRef } from "../../../shared/types";
import { Icon, type IconName } from "./Icon";
import { Key } from "./Key";

const MANAGER = window.moire.platform === "darwin" ? "Finder" : window.moire.platform === "win32" ? "Explorer" : "file manager";
const EDGE = 8;

export interface LineTarget {
  no: number | null;
  inHunk: boolean;
  text: string;
  picked: number;
  scope: number | "hunk" | "file" | null;
  file: FileDiff;
  lines: LineRef[] | null;
}

export interface MenuAt {
  path: string;
  x: number;
  y: number;
  file?: FileDiff;
  line?: LineTarget;
}

export type MenuAction =
  | "copy"
  | "copy-abs"
  | "copy-contents"
  | "reveal"
  | "editor"
  | "open"
  | "copy-here"
  | "stage-file"
  | "unstage-file"
  | "discard-file"
  | "copy-text"
  | "copy-lines"
  | "copy-markdown"
  | "stage-here"
  | "discard-here"
  | "editor-line";

interface Props {
  at: MenuAt;
  onDisk: boolean;
  copyHere: boolean;
  actions: "unstaged" | "staged" | null;
  changed: boolean;
  onPick(action: MenuAction): void;
  onClose(): void;
}

export function FileMenu({ at, onDisk, copyHere, actions, changed, onPick, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: at.x, top: at.y });
  const isDir = at.path.endsWith("/");

  useLayoutEffect(() => {
    const box = ref.current!.getBoundingClientRect();
    setPos({
      left: Math.max(EDGE, Math.min(at.x, window.innerWidth - box.width - EDGE)),
      top: Math.max(EDGE, at.y + box.height > window.innerHeight - EDGE ? at.y - box.height : at.y),
    });
    ref.current!.querySelector<HTMLButtonElement>("button:enabled")?.focus({ preventScroll: true });
  }, [at]);

  useEffect(() => {
    const away = (event: Event) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const keys = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      const items = [...ref.current!.querySelectorAll<HTMLButtonElement>("button:enabled")];
      const i = items.indexOf(document.activeElement as HTMLButtonElement);
      items[(i + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
    };
    window.addEventListener("mousedown", away);
    window.addEventListener("scroll", away, true);
    window.addEventListener("resize", onClose);
    window.addEventListener("blur", onClose);
    window.addEventListener("keydown", keys);
    return () => {
      window.removeEventListener("mousedown", away);
      window.removeEventListener("scroll", away, true);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("keydown", keys);
    };
  }, [onClose]);

  const item = (action: MenuAction, icon: IconName, label: string, enabled = true, key?: CommandId) => (
    <button
      role="menuitem"
      disabled={!enabled}
      onClick={() => {
        onClose();
        onPick(action);
      }}
    >
      <Icon name={icon} />
      {label}
      {key && <Key id={key} />}
    </button>
  );

  return (
    <div className="file-menu" role="menu" aria-label={at.path} ref={ref} style={pos} onContextMenu={(e) => e.preventDefault()}>
      <div className="file-menu-path" data-tip={at.path}>
        <bdi>{at.line?.no ? `${at.path}:${at.line.no}` : at.path}</bdi>
      </div>
      {at.line ? (
        <LineItems line={at.line} actions={actions} item={item} />
      ) : (
        <>
          {changed && actions === "unstaged" && item("stage-file", "stage", "Stage file")}
          {changed && actions === "staged" && item("unstage-file", "unstage", "Unstage file")}
          {changed && actions === "unstaged" && item("discard-file", "discard", "Discard file")}
          {changed && actions && <div className="sep" />}
        </>
      )}
      {item("copy", "copy", "Copy relative path")}
      {item("copy-abs", "copy", "Copy absolute path")}
      {!isDir && !at.line && item("copy-contents", "copy", "Copy contents", onDisk)}
      <div className="sep" />
      {item("reveal", "folder", `Show in ${MANAGER}`, onDisk)}
      {!isDir && !at.line && item("editor", "editor", "Open in editor", onDisk)}
      {!isDir && item("open", "open", "Open with default app", onDisk)}
      {isDir && <div className="sep" />}
      {isDir && item("copy-here", "paste", "Copy files here…", copyHere)}
    </div>
  );
}

interface LineItemsProps {
  line: LineTarget;
  actions: "unstaged" | "staged" | null;
  item(action: MenuAction, icon: IconName, label: string, enabled?: boolean, key?: CommandId): React.ReactNode;
}

function LineItems({ line, actions, item }: LineItemsProps) {
  const count = (n: number) => (n === 1 ? "line" : `${n} lines`);
  const canCopy = line.picked > 0 || line.inHunk;
  const what = typeof line.scope === "number" ? count(line.scope) : line.scope;
  return (
    <>
      {line.text && item("copy-text", "copy", "Copy")}
      {line.picked > 0 && item("copy-lines", "copy", "Copy lines", true, "copyCode")}
      {canCopy && item("copy-markdown", "markdown", `Copy ${line.picked ? count(line.picked) : "hunk"} as Markdown`, true, "copyMarkdown")}
      {actions &&
        what &&
        item("stage-here", actions === "staged" ? "unstage" : "stage", `${actions === "staged" ? "Unstage" : "Stage"} ${what}`, true, "stage")}
      {actions === "unstaged" && what && item("discard-here", "discard", `Discard ${what}`, true, "discard")}
      <div className="sep" />
      {item("editor-line", "editor", "Open in editor", !!line.no, "openEditor")}
    </>
  );
}
