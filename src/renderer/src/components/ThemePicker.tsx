import { useEffect, useRef, useState } from "react";
import { Key, keyText, useKeymap } from "./Key";

export const THEMES = [
  { id: "light", name: "Plate", tone: "light", note: "Glass plate on a light table. The default." },
  { id: "dark", name: "Plate dark", tone: "dark", note: "The same plates in a dim room." },
  { id: "pad", name: "Engineering pad", tone: "light", note: "Green computation paper, red and blue pencil." },
  { id: "p7", name: "P7 phosphor", tone: "dark", note: "Radar scope. Old code is the yellow afterglow, new code the blue flash." },
  { id: "safelight", name: "Safelight", tone: "dark", note: "Darkroom amber with no blue light, for late nights." },
  { id: "cyanotype", name: "Cyanotype", tone: "dark", note: "Prussian blue print, sensitiser yellow for new code." },
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];
export const THEME_IDS = THEMES.map((t) => t.id);
export const toneOf = (id: ThemeId) => THEMES.find((t) => t.id === id)?.tone ?? "light";
export const LIGHT_IDS = THEME_IDS.filter((id) => toneOf(id) === "light");
export const DARK_IDS = THEME_IDS.filter((id) => toneOf(id) === "dark");

interface Props {
  theme: ThemeId;
  cvd: boolean;
  onTheme(theme: ThemeId): void;
  onCvd(on: boolean): void;
}

export function ThemePicker({ theme, cvd, onTheme, onCvd }: Props) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const current = THEMES.find((t) => t.id === theme) ?? THEMES[0];
  const toggle = keyText(useKeymap(), "theme");

  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const esc = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);

  return (
    <div className="themes" ref={boxRef}>
      <button
        className="theme-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        title={toggle ? `Theme (${toggle} switches light and dark)` : "Theme"}
        onClick={() => setOpen(!open)}
      >
        <span className="pair" aria-hidden="true">
          <i />
          <i />
        </span>
        {current.name}
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
              <span>
                {t.name}
                <small>{t.note}</small>
              </span>
            </button>
          ))}
          <div className="sep" />
          <button className="cvd-opt" role="menuitemcheckbox" aria-checked={cvd} onClick={() => onCvd(!cvd)}>
            <span className="cvd-pair" aria-hidden="true">
              <i style={{ background: "#c45a00" }} />
              <i style={{ background: "#1f62c4" }} />
            </span>
            <span>
              Colour-blind safe plates
              <small>Orange for A, blue for B, in any theme.</small>
            </span>
            <span className="switch" aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}
