import { describe, expect, it } from "vitest";
import { paletteOf, presetCss, resolvePresets, safePaletteOf, toneBaseOf } from "./presets";
import { contrast, hardToRead, PALETTE_VARS, type Palette } from "./themeRules";

const file = (...themes: unknown[]) => JSON.stringify({ themes });
const base: Palette = Object.fromEntries(PALETTE_VARS.map((key) => [key, "#808080"]));

describe("resolvePresets", () => {
  it("is empty without a file, and ignores comment keys", () => {
    expect(resolvePresets(null)).toEqual({ presets: [], problems: [] });
    expect(resolvePresets('{"//": "help", "themes": []}')).toEqual({ presets: [], problems: [] });
  });

  it("reads a theme, and lowercases its colours", () => {
    const { presets, problems } = resolvePresets(file({ name: "Sea Glass", extends: "anodic", colors: { a: "#E0A050" } }));
    expect(problems).toEqual([]);
    expect(presets).toEqual([{ id: "custom-sea-glass", name: "Sea Glass", tone: "dark", base: "anodic", colors: { a: "#e0a050" } }]);
  });

  it.each([
    ["not json", "{", /valid JSON/],
    ["a bare list", "[]", /one object/],
    ["no name", file({ extends: "dark" }), /needs a name/],
    ["a name with nothing to slug", file({ name: "!!!", extends: "dark" }), /needs a name/],
    ["a repeated name", file({ name: "Mine", extends: "dark" }, { name: "mine", extends: "dark" }), /already taken/],
    ["names that make the same id", file({ name: "Sea Glass", extends: "dark" }, { name: "sea-glass", extends: "light" }), /already taken/],
    ["an unknown base", file({ name: "Mine", extends: "nope" }), /extends should be/],
  ])("explains %s", (_name, text, problem) => {
    expect(resolvePresets(text).problems.join(" ")).toMatch(problem);
  });

  it.each([
    ["unknown names", { nope: "#000000" }, /no colour is called "nope"/],
    ["anything but six-digit hex", { a: "#fff" }, /should be a colour/],
    ["stylesheet text in a value", { a: "red; } body { display: none" }, /should be a colour/],
  ])("drops %s but keeps the theme", (_name, colors, problem) => {
    const { presets, problems } = resolvePresets(file({ name: "Mine", extends: "dark", colors }));
    expect(presets![0].colors).toEqual({});
    expect(problems.join(" ")).toMatch(problem);
  });

  it.each([
    ["shares a built-in's name, so a new built-in can't hide it", ["Plate"], ["custom-plate"]],
    ["has markup in its name, which stays out of the id", ['a"]{}'], ["custom-a"]],
    ["is named in any script, keeping them apart", ["Тёмная 1", "Светлая 1"], ["custom-тёмная-1", "custom-светлая-1"]],
  ])("takes an id for a theme that %s", (_name, names, ids) => {
    const { presets, problems } = resolvePresets(file(...names.map((name) => ({ name, extends: "dark" }))));
    expect(problems).toEqual([]);
    expect(presets!.map((p) => p.id)).toEqual(ids);
  });

  it("starts from a built-in by its id or its name in the menu", () => {
    const { presets, problems } = resolvePresets(file({ name: "A", extends: "pad" }, { name: "B", extends: "Ledger" }, { name: "C", extends: "phosphor" }));
    expect(presets!.map((p) => p.base)).toEqual(["pad", "pad", "p7"]);
    expect(problems).toEqual([]);
  });

  it("takes the tone from the plate, and what it leaves out from a built-in of that tone", () => {
    const { presets } = resolvePresets(
      file(
        { name: "Paper", extends: "anodic", colors: { plate: "#f5f5f0" } },
        { name: "Ink", extends: "gypsum", colors: { plate: "#101214" } },
        { name: "Same", extends: "anodic" },
      ),
    );
    expect(presets!.map((p) => p.tone)).toEqual(["light", "dark", "dark"]);
    expect(presets!.map(toneBaseOf)).toEqual(["light", "dark", "anodic"]);
  });

  it("says nothing about the themes when the file can't be read as a whole", () => {
    expect(resolvePresets("{").presets).toBeNull();
    expect(resolvePresets("[]").presets).toBeNull();
    expect(resolvePresets(file({ name: "Mine", extends: "nope" })).presets).toEqual([]);
  });
});

describe("paletteOf", () => {
  it("keeps the base when nothing is set", () => {
    expect(paletteOf(base, {}, "dark")).toEqual(base);
  });

  it("works out tints from a new diff colour, and keeps what's named", () => {
    const out = paletteOf({ ...base, plate: "#000000" }, { a: "#ff0000", "a-word": "#111111" }, "dark");
    expect(out["a-line"]).not.toBe(base["a-line"]);
    expect(out["a-word"]).toBe("#111111");
    expect(out["a-ink"]).toBe("#ff0000");
    expect(out["b-line"]).toBe("#808080");
  });

  it("moves surfaces and tints onto a new ground", () => {
    const out = paletteOf(base, { plate: "#000000" }, "dark");
    expect(out.frame).not.toBe(base.frame);
    expect(out["a-line"]).not.toBe(base["a-line"]);
  });

  it("leaves colour-blind plates to the base, but moves their tints with the ground", () => {
    const colors = { a: "#ff0000", plate: "#000000" };
    const safe = safePaletteOf({ ...base, a: "#ff9b4e" }, paletteOf(base, colors, "dark"), colors, "dark");
    expect(safe.a).toBe("#ff9b4e");
    expect(safe.plate).toBe("#000000");
    expect(safe["a-line"]).not.toBe(base["a-line"]);
  });

  it("gives a readable theme from a sensible plate and diff colours", () => {
    const dark = { ...base, plate: "#1f2123", ink: "#e5e8eb" };
    const out = paletteOf(dark, { plate: "#1c2326", a: "#e0a050", b: "#70b8d0" }, "dark");
    expect(contrast(out, "dark").filter((p) => /a-ink|b-ink/.test(p) && /plate|frame/.test(p))).toEqual([]);
  });
});

describe("presetCss", () => {
  it("writes every variable, the colour scheme and a colour-blind block", () => {
    const preset = { id: "custom-mine", name: "Mine", tone: "dark" as const, base: "dark", colors: {} };
    const css = presetCss(preset, base, base);
    expect(PALETTE_VARS.every((key) => css.includes(`--${key}: `))).toBe(true);
    expect(css).toContain("color-scheme: dark");
    expect(css).toContain('[data-theme="custom-mine"][data-cvd="on"]');
  });
});

describe("hardToRead", () => {
  const readable = {
    ...Object.fromEntries(PALETTE_VARS.map((key) => [key, "#e5e8eb"])),
    plate: "#1c2326",
    "a-line": "#2c2a26",
    "b-line": "#223036",
    a: "#e0a050",
    b: "#70b8d0",
  };

  it("passes a readable palette, names what's too dim, and notices when A and B look alike", () => {
    expect(hardToRead(readable)).toEqual([]);
    expect(hardToRead({ ...readable, "tok-str": "#303030" })[0]).toMatch(/^strings on the background 1\.\d:1, needs 4\.5:1$/);
    expect(hardToRead({ ...readable, b: "#e0a052" })).toContain("A and B look too alike");
    expect(hardToRead({ ...readable, "a-ink": readable.plate })[0]).toMatch(/^A text on the background/);
  });
});
