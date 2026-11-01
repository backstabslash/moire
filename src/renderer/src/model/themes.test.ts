import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { alerts, contrast, PALETTE_VARS, type Palette, plates, syntax, tints } from "./themeRules";
import { THEMES } from "./themes";

const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

function block(selector: string): Palette {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no ${selector} block in styles.css`);
  const body = css.slice(start, css.indexOf("}", start));
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/g)].map((m) => [m[1], m[2]]));
}

describe.each(THEMES)("$name", ({ id, tone }) => {
  const base = block(`[data-theme="${id}"]`);
  const safe = { ...base, ...block(`[data-theme="${id}"][data-cvd="on"]`) };

  it("is readable on every surface, with and without colour-blind plates", () => {
    expect(contrast(base, tone)).toEqual([]);
    expect(contrast(safe, tone)).toEqual([]);
  });

  it("keeps the plates apart for red-green colour blindness", () => {
    expect(plates(base, false)).toEqual([]);
    expect(plates(safe, true)).toEqual([]);
  });

  it("keeps full and half line tints off the plate", () => {
    expect(tints(base)).toEqual([]);
    expect(tints(safe)).toEqual([]);
  });

  it("keeps syntax quiet and its colours apart", () => {
    expect(syntax(base)).toEqual([]);
    expect(syntax(safe)).toEqual([]);
  });

  it("keeps alert tones readable, apart, and clear of the diff colours", () => {
    expect(alerts(base)).toEqual([]);
    expect(alerts(safe)).toEqual([]);
  });

  it("sets every variable and its tone's colour scheme, since anything missing silently inherits Plate", () => {
    expect(Object.keys(base).sort()).toEqual([...PALETTE_VARS].sort());
    expect(Object.keys(block(`[data-theme="${id}"][data-cvd="on"]`)).sort()).toEqual(["a", "a-ink", "a-line", "a-word", "b", "b-ink", "b-line", "b-word"]);
    const start = css.indexOf(`[data-theme="${id}"] {`);
    expect(css.slice(start, css.indexOf("}", start))).toContain(`color-scheme: ${tone}`);
  });
});
