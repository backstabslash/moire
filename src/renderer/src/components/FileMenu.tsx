import { useEffect, useLayoutEffect, useRef, useState } from "react";

const MANAGER = window.moire.platform === "darwin" ? "Finder" : window.moire.platform === "win32" ? "Explorer" : "file manager";
const EDGE = 8;

export interface MenuAt {
  path: string;
  x: number;
  y: number;
}

export type MenuAction = "copy" | "copy-abs" | "copy-contents" | "reveal" | "editor" | "open" | "copy-here";

interface Props {
  at: MenuAt;
  onDisk: boolean;
  copyHere: boolean;
  onPick(action: MenuAction): void;
  onClose(): void;
}

export function FileMenu({ at, onDisk, copyHere, onPick, onClose }: Props) {
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

  const item = (action: MenuAction, label: string, enabled = true) => (
    <button
      role="menuitem"
      disabled={!enabled}
      onClick={() => {
        onClose();
        onPick(action);
      }}
    >
      {label}
    </button>
  );

  return (
    <div className="file-menu" role="menu" aria-label={at.path} ref={ref} style={pos} onContextMenu={(e) => e.preventDefault()}>
      <div className="file-menu-path" title={at.path}>
        <bdi>{at.path}</bdi>
      </div>
      {item("copy", "Copy relative path")}
      {item("copy-abs", "Copy absolute path")}
      {!isDir && item("copy-contents", "Copy contents", onDisk)}
      <div className="sep" />
      {item("reveal", `Show in ${MANAGER}`, onDisk)}
      {!isDir && item("editor", "Open in editor", onDisk)}
      {!isDir && item("open", "Open with default app", onDisk)}
      {isDir && <div className="sep" />}
      {isDir && item("copy-here", "Copy files here…", copyHere)}
    </div>
  );
}
