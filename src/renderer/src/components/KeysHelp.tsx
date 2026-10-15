import { useEffect, useRef } from "react";
import { COMMAND_IDS, COMMANDS, GROUPS, strokeLabel } from "../../../shared/keymap";
import { MAC, useKeymap } from "./Key";

export function KeysHelp({ onClose, onEdit }: { onClose(): void; onEdit(): void }) {
  const keymap = useKeymap();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const away = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const esc = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", esc);
    };
  }, [onClose]);

  return (
    <div className="keys-help" role="dialog" aria-label="Keyboard shortcuts" ref={ref}>
      <div className="keys-groups">
        {GROUPS.map((group) => (
          <section key={group}>
            <h3>{group}</h3>
            {COMMAND_IDS.filter((id) => COMMANDS[id].group === group && keymap.keys[id].length).map((id) => (
              <div className="keys-row" key={id} title={`"${id}" in keys.json`}>
                <span>{COMMANDS[id].label}</span>
                <span>
                  {keymap.keys[id].map((key) => (
                    <kbd key={key}>{strokeLabel(key, MAC)}</kbd>
                  ))}
                </span>
              </div>
            ))}
          </section>
        ))}
      </div>
      <div className="keys-foot">
        <span>Click or drag line numbers to select lines, Shift-click to extend.</span>
        <span className="keys-links">
          <button onClick={onEdit}>Edit keyboard shortcuts…</button>
          {/* Linux windows have no menu bar to reach these from. */}
          <button onClick={() => void window.moire.reportIssue()}>Report an issue…</button>
          <button onClick={() => void window.moire.checkForUpdates()}>Check for updates…</button>
        </span>
      </div>
    </div>
  );
}
