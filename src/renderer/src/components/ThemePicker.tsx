import { useEffect, useRef } from "react";
import { Icon } from "./Icon";
import { CUSTOM_PREFIX, type Theme, type ThemeId } from "../model/themes";
import { Key, keyText, useKeymap } from "./Key";

interface Props {
  open: boolean;
  onOpen(open: boolean): void;
  theme: ThemeId;
  themes: readonly Theme[];
  onEditThemes(): void;
  problems: readonly string[];
  warnings: Readonly<Record<string, string[]>>;
  cvd: boolean;
  follow: boolean;
  onTheme(theme: ThemeId): void;
  onCvd(on: boolean): void;
  onFollow(on: boolean): void;
  codeFont: string;
  codeSize: number;
  onCodeFont(font: string): void;
  onCodeSize(size: number): void;
}

export const CODE_SIZE = { initial: 15, min: 11, max: 20 };

export function ThemePicker({
  open,
  onOpen,
  theme,
  themes,
  onEditThemes,
  problems,
  warnings,
  cvd,
  follow,
  onTheme,
  onCvd,
  onFollow,
  codeFont,
  codeSize,
  onCodeFont,
  onCodeSize,
}: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const current = themes.find((t) => t.id === theme) ?? themes[0];
  const toggle = keyText(useKeymap(), "theme");

  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (!boxRef.current?.contains(event.target as Node)) onOpen(false);
    };
    window.addEventListener("mousedown", away);
    return () => window.removeEventListener("mousedown", away);
  }, [open, onOpen]);

  const wasOpen = useRef(false);
  useEffect(() => {
    if (open) gridRef.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    else if (wasOpen.current && document.activeElement === document.body) buttonRef.current?.focus();
    wasOpen.current = open;
  }, [open]);

  const walkGrid = (event: React.KeyboardEvent) => {
    const columns = [...(gridRef.current?.children ?? [])].map((column) => [...column.children] as HTMLElement[]);
    const col = columns.findIndex((list) => list.includes(document.activeElement as HTMLElement));
    if (col < 0) return;
    const row = columns[col].indexOf(document.activeElement as HTMLElement);
    const count = columns[col].length;
    const other = columns[1 - col];
    const to =
      event.key === "ArrowDown"
        ? columns[col][(row + 1) % count]
        : event.key === "ArrowUp"
          ? columns[col][(row - 1 + count) % count]
          : event.key === "ArrowLeft" || event.key === "ArrowRight"
            ? other[Math.min(row, other.length - 1)]
            : null;
    if (!to) return;
    event.preventDefault();
    to.focus();
  };

  return (
    <div className="themes" ref={boxRef}>
      <button
        ref={buttonRef}
        className="theme-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Theme: ${current.name}`}
        data-tip={toggle ? `${current.name} (${toggle} switches light and dark)` : current.name}
        onClick={() => onOpen(!open)}
      >
        <span className="pair" aria-hidden="true">
          <i />
          <i />
        </span>
        <Key id="theme" />
      </button>
      {open && (
        <div className="theme-pop" role="menu">
          <div className="theme-grid" ref={gridRef} onKeyDown={walkGrid}>
            {(["light", "dark"] as const).map((tone) => (
              <div key={tone}>
                {themes
                  .filter((t) => t.tone === tone)
                  .map((t) => (
                    <button
                      key={t.id}
                      className="theme-opt"
                      role="menuitemradio"
                      aria-checked={t.id === theme}
                      data-tip={
                        warnings[t.id] ? `${t.name} may be hard to read:\n${warnings[t.id].join("\n")}` : t.id.startsWith(CUSTOM_PREFIX) ? t.name : undefined
                      }
                      onClick={() => onTheme(t.id)}
                    >
                      <span className="specimen" data-theme={t.id} data-cvd={cvd ? "on" : "off"} aria-hidden="true">
                        <i />
                        <i />
                        <i />
                      </span>
                      <span className="theme-name">{t.name}</span>
                      {warnings[t.id] && <i className="theme-warn" role="img" aria-label="May be hard to read" />}
                    </button>
                  ))}
              </div>
            ))}
          </div>
          <div className="sep" />
          <button className="cvd-opt" role="menuitemcheckbox" aria-checked={follow} onClick={() => onFollow(!follow)}>
            <span className="cvd-pair" aria-hidden="true">
              <Icon name="system" />
            </span>
            <span>Follow system</span>
            <span className="switch" aria-hidden="true" />
          </button>
          <button className="cvd-opt" role="menuitemcheckbox" aria-checked={cvd} onClick={() => onCvd(!cvd)}>
            <span className="cvd-pair" data-theme={theme} data-cvd="on" aria-hidden="true">
              <i style={{ background: "var(--a)" }} />
              <i style={{ background: "var(--b)" }} />
            </span>
            <span>Colour-blind safe plates</span>
            <span className="switch" aria-hidden="true" />
          </button>
          <button className="cvd-opt" role="menuitem" onClick={onEditThemes}>
            <span className="cvd-pair" aria-hidden="true">
              <Icon name="editor" />
            </span>
            <span>Custom themes…</span>
          </button>
          {problems.length > 0 && (
            <ul className="theme-problems">
              {problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          )}
          <div className="sep" />
          <div className="code-type">
            <label>
              <span>Code font</span>
              <input value={codeFont} placeholder="Commit Mono" spellCheck={false} onChange={(e) => onCodeFont(e.target.value)} />
            </label>
            <span className="code-size" role="group" aria-label="Code size">
              <button aria-label="Smaller code" disabled={codeSize <= CODE_SIZE.min} onClick={() => onCodeSize(codeSize - 1)}>
                −
              </button>
              <output>{codeSize}</output>
              <button aria-label="Larger code" disabled={codeSize >= CODE_SIZE.max} onClick={() => onCodeSize(codeSize + 1)}>
                +
              </button>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
