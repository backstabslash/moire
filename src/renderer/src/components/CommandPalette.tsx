import { useEffect, useMemo, useRef, useState } from "react";
import { COMMAND_IDS, COMMANDS, type CommandId, keyLabel } from "../../../shared/keymap";
import { rankByLabel } from "../model/palette";
import { MAC, useKeymap } from "./Key";

const NOT_IN_PALETTE = new Set<CommandId>(["palette", "cancel", "blinkHold", "extendDown", "extendUp"]);

interface Props {
  available(id: CommandId): boolean;
  onRun(id: CommandId): void;
  onClose(): void;
}

export function CommandPalette({ available, onRun, onClose }: Props) {
  const keymap = useKeymap();
  const [query, setQuery] = useState("");
  const [hot, setHot] = useState(0);
  const [cameFrom] = useState(() => document.activeElement);
  const boxRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const commands = useMemo(
    () => COMMAND_IDS.filter((id) => !NOT_IN_PALETTE.has(id) && available(id)).map((id) => ({ id, label: COMMANDS[id].label, group: COMMANDS[id].group })),
    [available],
  );
  const shown = useMemo(() => rankByLabel(query, commands), [query, commands]);
  const pick = (id: CommandId) => {
    onClose();
    onRun(id);
  };

  useEffect(() => {
    return () => {
      if (document.activeElement === document.body && cameFrom instanceof HTMLElement) cameFrom.focus({ preventScroll: true });
    };
  }, [cameFrom]);

  useEffect(() => {
    const away = (event: MouseEvent) => {
      if (!boxRef.current?.contains(event.target as Node)) onClose();
    };
    window.addEventListener("mousedown", away);
    return () => window.removeEventListener("mousedown", away);
  }, [onClose]);

  useEffect(() => {
    listRef.current?.querySelector(".is-hot")?.scrollIntoView({ block: "nearest" });
  }, [hot]);

  return (
    <div className="palette" role="dialog" aria-label="Command palette" ref={boxRef}>
      <input
        autoFocus
        value={query}
        placeholder="Type a command"
        aria-label="Search commands"
        spellCheck={false}
        onChange={(e) => {
          setQuery(e.target.value);
          setHot(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") setHot((h) => Math.min(shown.length - 1, h + 1));
          else if (e.key === "ArrowUp") setHot((h) => Math.max(0, h - 1));
          else if (e.key === "Enter" && shown[hot]) pick(shown[hot].id);
          else if (e.key === "Escape") onClose();
          else if (e.key !== "Tab") return;
          e.preventDefault();
        }}
      />
      <div className="palette-list" role="listbox" aria-label="Commands" ref={listRef}>
        {shown.map(({ id, label, group }, i) => (
          <button key={id} role="option" aria-selected={i === hot} className={i === hot ? "is-hot" : ""} onMouseMove={() => setHot(i)} onClick={() => pick(id)}>
            <span>{label}</span>
            <small>{group}</small>
            {keymap.keys[id].length > 0 && <kbd>{keyLabel(keymap, id, MAC)}</kbd>}
          </button>
        ))}
        {!shown.length && <div className="no-match">No commands match.</div>}
      </div>
    </div>
  );
}
