import { useEffect, useRef } from "react";
import { Icon } from "./Icon";
import { Key, keyText, useKeymap } from "./Key";

export const THEMES = [
  { id: "light", name: "Plate", tone: "light" },
  { id: "dark", name: "Plate dark", tone: "dark" },
  { id: "pad", name: "Engineering pad", tone: "light" },
  { id: "p7", name: "P7 phosphor", tone: "dark" },
  { id: "safelight", name: "Safelight", tone: "dark" },
  { id: "cyanotype", name: "Cyanotype", tone: "dark" },
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];
export const THEME_IDS = THEMES.map((t) => t.id);
export const toneOf = (id: ThemeId) => THEMES.find((t) => t.id === id)?.tone ?? "light";
export const LIGHT_IDS = THEME_IDS.filter((id) => toneOf(id) === "light");
export const DARK_IDS = THEME_IDS.filter((id) => toneOf(id) === "dark");

interface Props {
  open: boolean;
  onOpen(open: boolean): void;
  theme: ThemeId;
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

export function ThemePicker({ open, onOpen, theme, cvd, follow, onTheme, onCvd, onFollow, codeFont, codeSize, onCodeFont, onCodeSize }: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const current = THEMES.find((t) => t.id === theme) ?? THEMES[0];
  const toggle = keyText(useKeymap(), "theme");

  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (!boxRef.current?.contains(event.target as Node)) onOpen(false);
    };
    window.addEventListener("mousedown", away);
    return () => window.removeEventListener("mousedown", away);
  }, [open, onOpen]);

  return (
    <div className="themes" ref={boxRef}>
      <button
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
          {THEMES.map((t) => (
            <button key={t.id} className="theme-opt" role="menuitemradio" aria-checked={t.id === theme} onClick={() => onTheme(t.id)}>
              <span className="specimen" data-theme={t.id} data-cvd={cvd ? "on" : "off"} aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              <span>{t.name}</span>
            </button>
          ))}
          <div className="sep" />
          <button className="cvd-opt" role="menuitemcheckbox" aria-checked={follow} onClick={() => onFollow(!follow)}>
            <span className="cvd-pair" aria-hidden="true">
              <Icon name="system" />
            </span>
            <span>Follow system</span>
            <span className="switch" aria-hidden="true" />
          </button>
          <button className="cvd-opt" role="menuitemcheckbox" aria-checked={cvd} onClick={() => onCvd(!cvd)}>
            <span className="cvd-pair" aria-hidden="true">
              <i style={{ background: "#c45a00" }} />
              <i style={{ background: "#1f62c4" }} />
            </span>
            <span>Colour-blind safe plates</span>
            <span className="switch" aria-hidden="true" />
          </button>
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
