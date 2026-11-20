import { CUSTOM_PREFIX, idsOf, isThemeId, type Theme, type ThemeId, type Tone, toneOf } from "./themes";

export interface Appearance {
  mode: Tone | "system";
  light: ThemeId;
  dark: ThemeId;
  cvd: boolean;
}

const isMode = (mode: unknown): mode is Appearance["mode"] => mode === "system" || mode === "light" || mode === "dark";
const isId = (id: unknown): id is ThemeId => typeof id === "string" && isThemeId(id);

const toneShown = (a: Appearance, system: Tone): Tone => (a.mode === "system" ? system : a.mode);

// A custom theme goes missing or flips tone while its entry is mid-edit, so only what's shown falls back and the slot waits for it.
export function themeShown(a: Appearance, system: Tone, themes: readonly Theme[]): ThemeId {
  const tone = toneShown(a, system);
  return idsOf(themes, tone).includes(a[tone]) ? a[tone] : tone;
}

export function pickTheme(a: Appearance, id: ThemeId, system: Tone, themes: readonly Theme[]): Appearance {
  const tone = toneOf(id, themes);
  return { ...a, [tone]: id, mode: a.mode === "system" && tone === system ? "system" : tone };
}

export const flipTone = (a: Appearance, system: Tone): Appearance => ({ ...a, mode: toneShown(a, system) === "dark" ? "light" : "dark" });

export const followSystem = (a: Appearance, on: boolean, system: Tone): Appearance => ({ ...a, mode: on ? "system" : toneShown(a, system) });

export function readAppearance(saved: string | null, legacy: (key: string) => string | null, system: Tone): Appearance {
  const a = parsed(saved);
  if (a && isMode(a.mode)) return { mode: a.mode, light: isId(a.light) ? a.light : "light", dark: isId(a.dark) ? a.dark : "dark", cvd: a.cvd === true };
  return fromLegacy(legacy, system);
}

function parsed(saved: string | null): Partial<Appearance> | null {
  try {
    return JSON.parse(saved ?? "null") as Partial<Appearance> | null;
  } catch {
    return null;
  }
}

// Before 0.2.2 every appearance setting had its own key.
function fromLegacy(legacy: (key: string) => string | null, system: Tone): Appearance {
  const theme = legacy("theme");
  const follow = legacy("theme-follow");
  const builtIn = isId(theme) && !theme.startsWith(CUSTOM_PREFIX) ? theme : null;
  const slot = (tone: Tone) => {
    const saved = legacy(`theme-${tone}`);
    return isId(saved) ? saved : builtIn && toneOf(builtIn) === tone ? builtIn : tone;
  };
  const a = { light: slot("light"), dark: slot("dark"), cvd: legacy("cvd") === "on" };
  // New installs follow the desktop; anyone who already had a theme keeps it until they opt in.
  if (follow === "on" || (follow === null && !theme)) return { mode: "system", ...a };
  const mode = theme === a.dark ? "dark" : theme === a.light ? "light" : builtIn ? toneOf(builtIn) : system;
  return { mode, ...a };
}
