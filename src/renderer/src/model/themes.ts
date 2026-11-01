export type Tone = "light" | "dark";

export interface Theme {
  id: string;
  name: string;
  tone: Tone;
}

export const THEMES: readonly Theme[] = [
  { id: "light", name: "Plate", tone: "light" },
  { id: "pad", name: "Ledger", tone: "light" },
  { id: "gypsum", name: "Gypsum", tone: "light" },
  { id: "blue-base", name: "Lightbox", tone: "light" },
  { id: "fathom", name: "Fathom", tone: "light" },
  { id: "ditto", name: "Ditto", tone: "light" },
  { id: "dark", name: "Negative", tone: "dark" },
  { id: "p7", name: "Phosphor", tone: "dark" },
  { id: "safelight", name: "Safelight", tone: "dark" },
  { id: "cyanotype", name: "Cyanotype", tone: "dark" },
  { id: "anodic", name: "Anodic", tone: "dark" },
  { id: "mezzotint", name: "Mezzotint", tone: "dark" },
];

export type ThemeId = string;
export const toneOf = (id: ThemeId, themes = THEMES) => themes.find((t) => t.id === id)?.tone ?? "light";
export const idsOf = (themes: readonly Theme[], tone?: Tone) => themes.filter((t) => !tone || t.tone === tone).map((t) => t.id);
export const CUSTOM_PREFIX = "custom-";
export const isThemeId = (id: ThemeId) => id.startsWith(CUSTOM_PREFIX) || idsOf(THEMES).includes(id);
