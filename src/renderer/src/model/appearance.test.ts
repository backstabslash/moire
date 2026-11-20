import { describe, expect, it } from "vitest";
import { type Appearance, flipTone, followSystem, pickTheme, readAppearance, themeShown } from "./appearance";
import { THEMES } from "./themes";

const following: Appearance = { mode: "system", light: "pad", dark: "p7", cvd: false };
const legacy = (keys: Record<string, string>) => (key: string) => keys[key] ?? null;

describe("themeShown", () => {
  it("shows the desktop's slot while following, and the chosen tone's otherwise", () => {
    expect(themeShown(following, "light", THEMES)).toBe("pad");
    expect(themeShown(following, "dark", THEMES)).toBe("p7");
    expect(themeShown({ ...following, mode: "dark" }, "light", THEMES)).toBe("p7");
  });

  it("stands in the built-in for a custom theme that's missing or changed tone, and keeps the slot", () => {
    const a = { ...following, light: "custom-paper" };
    expect(themeShown(a, "light", THEMES)).toBe("light");
    expect(themeShown(a, "light", [...THEMES, { id: "custom-paper", name: "Paper", tone: "dark" }])).toBe("light");
    expect(themeShown(a, "light", [...THEMES, { id: "custom-paper", name: "Paper", tone: "light" }])).toBe("custom-paper");
  });
});

describe("pickTheme", () => {
  it("keeps following for a theme in the desktop's tone, and stops for the other tone", () => {
    expect(pickTheme(following, "gypsum", "light", THEMES)).toEqual({ ...following, light: "gypsum" });
    expect(pickTheme(following, "safelight", "light", THEMES)).toEqual({ ...following, mode: "dark", dark: "safelight" });
  });

  it("switches tone when not following", () => {
    expect(pickTheme({ ...following, mode: "dark" }, "gypsum", "dark", THEMES)).toEqual({ ...following, mode: "light", light: "gypsum" });
  });
});

describe("flipTone and followSystem", () => {
  it("t swaps tones without touching either slot, and stops following", () => {
    expect(flipTone(following, "light")).toEqual({ ...following, mode: "dark" });
    expect(flipTone({ ...following, mode: "dark" }, "light")).toEqual({ ...following, mode: "light" });
  });

  it("turning follow off keeps what's on screen", () => {
    expect(followSystem(following, false, "dark")).toEqual({ ...following, mode: "dark" });
    expect(followSystem({ ...following, mode: "light" }, true, "dark")).toEqual(following);
  });
});

describe("readAppearance", () => {
  it("reads what was saved, and replaces unknown themes with the built-ins", () => {
    expect(readAppearance(JSON.stringify(following), legacy({}), "light")).toEqual(following);
    expect(readAppearance('{"mode":"dark","light":"nope","dark":"custom-x","cvd":true}', legacy({}), "light")).toEqual({
      mode: "dark",
      light: "light",
      dark: "custom-x",
      cvd: true,
    });
  });

  it("follows the desktop on a new install, and after anything unreadable", () => {
    const fresh = { mode: "system", light: "light", dark: "dark", cvd: false };
    expect(readAppearance(null, legacy({}), "dark")).toEqual(fresh);
    expect(readAppearance("{", legacy({}), "dark")).toEqual(fresh);
    expect(readAppearance('{"mode":"sepia"}', legacy({}), "dark")).toEqual(fresh);
  });

  it("carries over the separate keys from before", () => {
    const old = { theme: "p7", "theme-light": "pad", "theme-dark": "p7" };
    expect(readAppearance(null, legacy(old), "light")).toEqual({ ...following, mode: "dark" });
    expect(readAppearance(null, legacy({ ...old, "theme-follow": "on", cvd: "on" }), "light")).toEqual({ ...following, cvd: true });
    expect(readAppearance(null, legacy({ theme: "gypsum" }), "dark")).toEqual({ mode: "light", light: "gypsum", dark: "dark", cvd: false });
    expect(readAppearance(null, legacy({ theme: "custom-x", "theme-dark": "custom-x" }), "light")).toEqual({
      mode: "dark",
      light: "light",
      dark: "custom-x",
      cvd: false,
    });
  });
});
