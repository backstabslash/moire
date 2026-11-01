import { lightness, PALETTE_VARS, type Palette } from "./themeRules";
import { CUSTOM_PREFIX, type Theme, THEMES, toneOf } from "./themes";

export interface Preset extends Theme {
  base: string;
  colors: Palette;
}

const HEX = /^#[0-9a-f]{6}$/;
const PLATE_VARS = ["a", "a-line", "a-word", "a-ink", "b", "b-line", "b-word", "b-ink"];
const MAX_NAME = 24;

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "");

function colorsOf(name: string, raw: unknown, problems: string[]): Palette {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    problems.push(`${name}: colors should be an object, like {"plate": "#1c2326"}.`);
    return {};
  }
  const colors: Palette = {};
  for (const [key, value] of Object.entries(raw)) {
    const hex = typeof value === "string" ? value.toLowerCase() : "";
    if (!PALETTE_VARS.includes(key)) problems.push(`${name}: no colour is called "${key}".`);
    else if (!HEX.test(hex)) problems.push(`${name}: ${key} should be a colour like #1c2326.`);
    else colors[key] = hex;
  }
  return colors;
}

// presets is null when the file can't be read as a whole, which says nothing about which themes the user still wants.
export function resolvePresets(text: string | null): { presets: Preset[] | null; problems: string[] } {
  if (text === null) return { presets: [], problems: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { presets: null, problems: [`It isn't valid JSON, so nothing in it was applied (${(e as Error).message}).`] };
  }
  const list = raw && typeof raw === "object" ? (raw as { themes?: unknown }).themes : undefined;
  if (!Array.isArray(list)) return { presets: null, problems: ['It should hold one object, like {"themes": []}, so nothing in it was applied.'] };

  const presets: Preset[] = [];
  const problems: string[] = [];
  const taken = new Set<string>();
  for (const [index, item] of (list as unknown[]).entries()) {
    const { name, extends: base, colors } = (item && typeof item === "object" ? item : {}) as { name?: unknown; extends?: unknown; colors?: unknown };
    const id = typeof name === "string" ? slug(name) : "";
    const parent = typeof base === "string" ? THEMES.find((t) => t.id === base || slug(t.name) === slug(base)) : undefined;
    if (typeof name !== "string" || !id || name.length > MAX_NAME) {
      problems.push(`Theme ${index + 1} needs a name of up to ${MAX_NAME} characters, with a letter or digit in it.`);
    } else if (taken.has(id)) {
      problems.push(`${name}: that name is already taken.`);
    } else if (!parent) {
      problems.push(`${name}: extends should be one of ${THEMES.map((t) => t.id).join(", ")}.`);
    } else {
      taken.add(id);
      const own = colorsOf(name, colors, problems);
      const tone = own.plate ? (lightness(own.plate) > 0.6 ? "light" : "dark") : parent.tone;
      presets.push({ id: `${CUSTOM_PREFIX}${id}`, name, tone, base: parent.id, colors: own });
    }
  }
  return { presets, problems };
}

function mix(a: string, b: string, share: number) {
  const part = (hex: string, i: number) => parseInt(hex.slice(i, i + 2), 16);
  const channels = [1, 3, 5].map((i) => Math.round(part(a, i) * (1 - share) + part(b, i) * share));
  return `#${channels.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

export function paletteOf(base: Palette, colors: Palette, tone: Theme["tone"]): Palette {
  const out = { ...base, ...colors };
  const fill = (key: string, value: string) => {
    if (!colors[key]) out[key] = value;
  };
  if (colors.plate || colors.ink) {
    fill("frame", mix(out.plate, out.ink, 0.05));
    fill("frame-2", mix(out.plate, out.ink, 0.1));
    fill("rule", mix(out.plate, out.ink, 0.2));
  }
  if (colors.ink) {
    fill("tok-ink", out.ink);
    fill("tok-kw", out.ink);
    fill("graphite", mix(out.ink, out.plate, 0.22));
    fill("faint", mix(out.ink, out.plate, 0.36));
  }
  const [line, word] = tone === "dark" ? [0.14, 0.28] : [0.14, 0.3];
  for (const side of ["a", "b"]) {
    if (!colors[side] && !colors.plate) continue;
    fill(`${side}-line`, mix(out.plate, out[side], line));
    fill(`${side}-word`, mix(out.plate, out[side], word));
    if (colors[side]) fill(`${side}-ink`, out[side]);
  }
  return out;
}

// Everything unnamed is tuned for one tone, so a preset that changed tone needs a built-in of its own.
export const toneBaseOf = ({ base, tone }: Preset) => (toneOf(base) === tone ? base : tone === "dark" ? "dark" : "light");

// A preset can't undo colour-blind plates, so only its ground carries over.
export function safePaletteOf(safeBase: Palette, palette: Palette, colors: Palette, tone: Theme["tone"]): Palette {
  const safe = paletteOf(safeBase, Object.fromEntries(Object.entries(colors).filter(([key]) => !PLATE_VARS.includes(key))), tone);
  return { ...palette, ...Object.fromEntries(PLATE_VARS.map((key) => [key, safe[key]])) };
}

export function presetCss({ id, tone }: Preset, palette: Palette, safe: Palette) {
  const lines = (vars: string[], from: Palette) => vars.map((key) => `  --${key}: ${from[key]};`).join("\n");
  return `[data-theme="${id}"] {\n${lines(PALETTE_VARS, palette)}\n  color-scheme: ${tone};\n}\n[data-theme="${id}"][data-cvd="on"] {\n${lines(PLATE_VARS, safe)}\n}\n`;
}
