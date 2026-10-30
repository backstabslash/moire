import { describe, expect, it } from "vitest";
import { swatches } from "./swatch";

describe("swatches", () => {
  it("finds every colour form in a stylesheet", () => {
    expect(swatches("  color: #17202a;", true)).toEqual([{ at: 9, color: "#17202a" }]);
    expect(swatches("border: 1px solid #abc", true)).toEqual([{ at: 18, color: "#abc" }]);
    expect(swatches("background: rgb(23 32 42 / 0.45);", true).map((s) => s.color)).toEqual(["rgb(23 32 42 / 0.45)"]);
    expect(swatches("a: oklch(0.6 0.1 200); b: #fff", true).map((s) => s.color)).toEqual(["oklch(0.6 0.1 200)", "#fff"]);
  });

  it("skips lengths that aren't colours and ids that only start like one", () => {
    expect(swatches("#12345 {}", true)).toEqual([]);
    expect(swatches("#add-file { top: 0 }", true)).toEqual([]);
  });

  it("only trusts whole quoted strings outside stylesheets", () => {
    expect(swatches('const frame = "#1f252c";', false)).toEqual([{ at: 15, color: "#1f252c" }]);
    expect(swatches("`rgb(1, 2, 3)`", false).map((s) => s.color)).toEqual(["rgb(1, 2, 3)"]);
    expect(swatches("// fixes #123", false)).toEqual([]);
    expect(swatches("rgb(r, g, b) + #fff", false)).toEqual([]);
  });
});
