import type { FileDiff } from "../../../shared/types";

const NAMES: Record<string, string> = {
  "\u00A0": "NBSP",
  "\u00AD": "SHY",
  "\u034F": "CGJ",
  "\u180E": "MVS",
  "\u200B": "ZWSP",
  "\u200C": "ZWNJ",
  "\u200D": "ZWJ",
  "\u202F": "NNBSP",
  "\u205F": "MMSP",
  "\u2060": "WJ",
  "\uFEFF": "BOM",
};

const TAGS = "\\u{E0020}-\\u{E007F}";
const SELECTORS = "\\uFE00-\\uFE0F\\u{E0100}-\\u{E01EF}";

// Emoji are spelled with these: a joiner after an emoji, a variation selector after one (or a CJK ideograph), and short tag runs after the black flag.
const SOURCE = [
  "[\\u00A0\\u180E\\u2000-\\u200A\\u202F\\u205F]",
  `\\p{Default_Ignorable_Code_Point}(?<![\\u200D${TAGS}${SELECTORS}])`,
  "(?<!\\p{Extended_Pictographic}[\\uFE0F\\u{1F3FB}-\\u{1F3FF}]?)\\u200D",
  `[${SELECTORS}](?<![\\p{Emoji}\\p{Ideographic}][${SELECTORS}])`,
  `[${TAGS}](?<!\\u{1F3F4}[${TAGS}]{1,7})`,
].join("|");

const INVISIBLE = new RegExp(SOURCE, "gu");
const ANY_INVISIBLE = new RegExp(SOURCE, "u");
export const MARKED = new RegExp(`(\\t|${SOURCE})`, "u");

export const hasInvisible = (text: string) => ANY_INVISIBLE.test(text);
const GROUPS: [RegExp, string][] = [
  [new RegExp(`[${TAGS}]`, "u"), "TAG"],
  [new RegExp(`[${SELECTORS}]`, "u"), "VS"],
  [/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/, "BIDI"],
  [/\p{Zs}/u, "SPACE"],
];
export const invisibleName = (ch: string) => NAMES[ch] ?? GROUPS.find(([re]) => re.test(ch))?.[1] ?? "HIDDEN";
export const codePoint = (ch: string) => `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;

export interface HiddenLine {
  text: string;
  chars: string[];
}

const SCAN_LIMIT = 5000;

export function hiddenLines(file: FileDiff): HiddenLine[] {
  if (file.noise || file.additions > SCAN_LIMIT) return [];
  return file.hunks.flatMap((h) =>
    h.lines.flatMap((l) => {
      const chars = l.kind === "add" ? l.text.match(INVISIBLE) : null;
      return chars ? [{ text: l.text, chars }] : [];
    }),
  );
}

export function hiddenKinds(lines: HiddenLine[]): { name: string; point: string; count: number }[] {
  const kinds = new Map<string, { name: string; point: string; count: number }>();
  for (const ch of lines.flatMap((l) => l.chars)) {
    const name = invisibleName(ch);
    const key = name === "TAG" || name === "VS" ? name : ch;
    const kind = kinds.get(key) ?? { name, point: codePoint(ch), count: 0 };
    kind.count++;
    kinds.set(key, kind);
  }
  return [...kinds.values()].sort((a, b) => b.count - a.count);
}
