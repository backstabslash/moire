import { useEffect, useRef, useState } from "react";
import type { EditorChoices } from "../../../shared/types";

interface Props {
  onPick(template: string): void;
  onClose(): void;
}

export function EditorPicker({ onPick, onClose }: Props) {
  const [choices, setChoices] = useState<EditorChoices | null>(null);
  const [custom, setCustom] = useState("");
  const [hot, setHot] = useState(0);
  const popRef = useRef<HTMLDivElement>(null);
  const installed = choices?.installed ?? [];

  useEffect(() => {
    window.moire.editors().then(setChoices, () => setChoices({ installed: [], fromEnv: false }));
  }, []);

  useEffect(() => {
    const away = (event: MouseEvent) => {
      if (!popRef.current?.contains(event.target as Node)) onClose();
    };
    window.addEventListener("mousedown", away);
    return () => window.removeEventListener("mousedown", away);
  }, [onClose]);

  const choose = () => {
    const template = custom.trim() || installed[hot]?.template;
    if (template) onPick(template);
  };

  return (
    <div className="picker-pop repo-pop editor-pop" ref={popRef}>
      <div className="picker-sub-head">{installed.length ? "Choose an editor" : "No editors found. Enter a command."}</div>
      <input
        autoFocus
        value={custom}
        placeholder="Or a command, such as code -g {file}:{line}"
        aria-label="Editor command"
        spellCheck={false}
        onChange={(e) => setCustom(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") setHot((h) => Math.min(installed.length - 1, h + 1));
          else if (e.key === "ArrowUp") setHot((h) => Math.max(0, h - 1));
          else if (e.key === "Enter") choose();
          else if (e.key === "Escape") onClose();
          else return;
          e.preventDefault();
        }}
      />
      <div role="listbox" aria-label="Installed editors">
        {installed.map((editor, i) => (
          <button
            key={editor.name}
            role="option"
            aria-selected={false}
            className={i === hot && !custom ? "is-hot" : ""}
            onMouseEnter={() => setHot(i)}
            onClick={() => onPick(editor.template)}
          >
            {editor.name}
            {editor.terminal && <span className="repo-tree">opens in a terminal</span>}
            <small>{editor.template}</small>
          </button>
        ))}
      </div>
      {choices?.fromEnv && <div className="editor-note">MOIRE_EDITOR is set, so it stays in charge until you unset it.</div>}
    </div>
  );
}
