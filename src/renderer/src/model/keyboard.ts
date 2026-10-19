import { NAMED_KEYS } from "../../../shared/keymap";

export interface KeyPress {
  key: string;
  code: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  isComposing?: boolean;
  getModifierState?(key: string): boolean;
}

const SHIFTED_DIGITS = ")!@#$%^&*(";
const PUNCTUATION: Record<string, string> = {
  Minus: "-_",
  Equal: "=+",
  BracketLeft: "[{",
  BracketRight: "]}",
  Backslash: "\\|",
  Semicolon: ";:",
  Quote: `'"`,
  Comma: ",<",
  Period: ".>",
  Slash: "/?",
  Backquote: "`~",
};

// What the key prints on a US layout, for layouts whose letters aren't Latin.
function fromCode(code: string, shift: boolean): string | null {
  if (/^Key[A-Z]$/.test(code)) return shift ? code[3] : code[3].toLowerCase();
  if (/^Digit\d$/.test(code)) return shift ? SHIFTED_DIGITS[Number(code[5])] : code[5];
  return PUNCTUATION[code]?.[shift ? 1 : 0] ?? null;
}

const printable = (c: string) => c.length === 1 && c >= "!" && c <= "~";

export function strokeOf(e: KeyPress, mac: boolean): string | null {
  if (e.isComposing || e.key === "Dead") return null;
  const altGr = !!e.getModifierState?.("AltGraph");
  if (mac ? e.ctrlKey : e.metaKey) return null;
  const mod = mac ? e.metaKey : e.ctrlKey && !altGr;
  // macOS German, French and Nordic layouts type [ ] / with Option, and Linux and Windows ones with AltGr.
  const typed = e.altKey || altGr;
  if (typed && (mod || !(mac || altGr))) return null;
  const prefix = (letter: boolean) => `${mod ? "Mod+" : ""}${e.shiftKey && (mod || !letter) ? "Shift+" : ""}`;

  if (NAMED_KEYS.has(e.key)) return `${prefix(false)}${e.key}`;
  if (e.key === " ") return `${prefix(false)}Space`;
  const ch = printable(e.key) ? e.key : typed ? null : fromCode(e.code, e.shiftKey);
  if (!ch) return null;
  if (/^[a-z]$/i.test(ch)) {
    if (mod) return `${prefix(true)}${ch.toLowerCase()}`;
    // Caps Lock flips the case event.key reports, Shift is what was meant.
    return e.shiftKey ? ch.toUpperCase() : ch.toLowerCase();
  }
  return mod ? `Mod+${ch}` : ch;
}

export function sameKey(a: string | null, b: string | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}
