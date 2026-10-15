import { describe, expect, it } from "vitest";
import { DEFAULT_KEYMAP, lookup } from "../../../shared/keymap";
import { type KeyPress, sameKey, strokeOf } from "./keyboard";

const press = (key: string, code: string, mods: Partial<KeyPress> & { altGr?: boolean } = {}): KeyPress => ({
  key,
  code,
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...mods,
  getModifierState: (m) => m === "AltGraph" && !!mods.altGr,
});

describe("strokeOf", () => {
  it("reads printable keys as typed", () => {
    expect(strokeOf(press("j", "KeyJ"), false)).toBe("j");
    expect(strokeOf(press("N", "KeyN", { shiftKey: true }), false)).toBe("N");
    expect(strokeOf(press("?", "Slash", { shiftKey: true }), false)).toBe("?");
    expect(strokeOf(press("]", "BracketRight"), false)).toBe("]");
    expect(strokeOf(press("Escape", "Escape"), false)).toBe("Escape");
    expect(strokeOf(press("ArrowDown", "ArrowDown", { shiftKey: true }), false)).toBe("Shift+ArrowDown");
  });

  it("falls back to the key's position when the layout isn't Latin", () => {
    expect(strokeOf(press("ы", "KeyS"), false)).toBe("s");
    expect(strokeOf(press("Ы", "KeyS", { shiftKey: true }), false)).toBe("S");
    expect(strokeOf(press("х", "BracketLeft"), false)).toBe("[");
    expect(strokeOf(press("с", "KeyC", { ctrlKey: true }), false)).toBe("Mod+c");
    expect(strokeOf(press("ї", "BracketRight"), false)).toBe("]");
  });

  it("uses the character, not the position, on Latin layouts", () => {
    expect(strokeOf(press("z", "KeyY"), false)).toBe("z");
    expect(strokeOf(press(".", "Slash"), false)).toBe(".");
  });

  it("ignores Caps Lock and goes by Shift", () => {
    expect(strokeOf(press("S", "KeyS"), false)).toBe("s");
    expect(strokeOf(press("s", "KeyS", { shiftKey: true }), false)).toBe("S");
  });

  it("lets Option and AltGr type characters, but not combine with letters", () => {
    expect(strokeOf(press("[", "Digit5", { altKey: true }), true)).toBe("[");
    expect(strokeOf(press("/", "Digit7", { altKey: true }), true)).toBe("/");
    expect(strokeOf(press("∆", "KeyJ", { altKey: true }), true)).toBeNull();
    expect(strokeOf(press("[", "Digit8", { altGr: true }), false)).toBe("[");
    expect(strokeOf(press("]", "Digit9", { altGr: true, ctrlKey: true, altKey: true }), false)).toBe("]");
    expect(strokeOf(press("j", "KeyJ", { altKey: true }), false)).toBeNull();
  });

  it("maps Ctrl on Linux and Cmd on macOS to Mod, and drops the other", () => {
    expect(strokeOf(press("z", "KeyZ", { ctrlKey: true }), false)).toBe("Mod+z");
    expect(strokeOf(press("z", "KeyZ", { metaKey: true }), true)).toBe("Mod+z");
    expect(strokeOf(press("Z", "KeyZ", { metaKey: true, shiftKey: true }), true)).toBe("Mod+Shift+z");
    expect(strokeOf(press("z", "KeyZ", { ctrlKey: true }), true)).toBeNull();
    expect(strokeOf(press("z", "KeyZ", { metaKey: true }), false)).toBeNull();
  });

  it("skips dead keys and composition", () => {
    expect(strokeOf(press("Dead", "BracketLeft"), false)).toBeNull();
    expect(strokeOf({ ...press("a", "KeyA"), isComposing: true }, false)).toBeNull();
  });
});

describe("lookup", () => {
  it("waits for the second key of a sequence and falls back to a single key", () => {
    expect(lookup(DEFAULT_KEYMAP, null, "g")).toBe("prefix");
    expect(lookup(DEFAULT_KEYMAP, "g", "g")).toBe("firstHunk");
    expect(lookup(DEFAULT_KEYMAP, "g", "j")).toBe("nextHunk");
    expect(lookup(DEFAULT_KEYMAP, null, "G")).toBe("lastHunk");
    expect(lookup(DEFAULT_KEYMAP, null, "q")).toBeNull();
  });
});

describe("sameKey", () => {
  it("matches a key released after Shift or Caps Lock changed its case", () => {
    expect(sameKey("B", "b")).toBe(true);
    expect(sameKey("b", "b")).toBe(true);
    expect(sameKey("n", "b")).toBe(false);
    expect(sameKey(null, "b")).toBe(false);
  });
});
