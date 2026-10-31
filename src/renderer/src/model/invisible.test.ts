import { describe, expect, it } from "vitest";
import type { DiffLine, FileDiff } from "../../../shared/types";
import { hiddenKinds, hiddenLines } from "./invisible";

const fileOf = (body: string[], extra: Partial<FileDiff> = {}): FileDiff => {
  const lines = body.map((line): DiffLine => ({ kind: line[0] === "-" ? "del" : line[0] === "+" ? "add" : "ctx", text: line.slice(1) }));
  return {
    path: "a.ts",
    status: "modified",
    binary: false,
    additions: lines.length,
    deletions: 0,
    hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 0, header: "", lines }],
    ...extra,
  };
};
const names = (file: FileDiff) => hiddenKinds(hiddenLines(file)).map((k) => k.name);

describe("hiddenLines", () => {
  it("finds every invisible character on added lines", () => {
    expect(hiddenLines(fileOf([" same", "+a\u00A0b\u200Bc"]))).toEqual([{ text: "a\u00A0b\u200Bc", chars: ["\u00A0", "\u200B"] }]);
  });

  it("counts each kind across lines, most common first", () => {
    expect(hiddenKinds(hiddenLines(fileOf(["+a\u200Bb", "+c\u00A0d\u00A0e"])))).toEqual([
      { name: "NBSP", point: "U+00A0", count: 2 },
      { name: "ZWSP", point: "U+200B", count: 1 },
    ]);
  });

  it("ignores removed and unchanged lines", () => {
    expect(names(fileOf(["-a\u00A0b", " c\u00A0d"]))).toEqual([]);
  });

  it.each([
    ["a joined emoji", "\u{1F468}\u200D\u{1F469}"],
    ["a joined emoji with a skin tone", "\u{1F469}\u{1F3FD}\u200D\u{1F4BB}"],
    ["emoji and ideographic variants", "\u2764\uFE0F 1\uFE0F\u20E3 \u8FBB\u{E0100}"],
    ["a tag flag", "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}"],
  ])("leaves %s alone", (_, text) => {
    expect(names(fileOf([`+${text}`]))).toEqual([]);
  });

  it.each([
    ["tag characters", "\u{E0041}\u{E0042}", "TAG"],
    ["variation selectors on plain text", "a\u{E0100}\u{E0101}\uFE01", "VS"],
    ["a variation selector stacked on an emoji", "\u{1F600}\uFE0F\uFE00", "VS"],
    ["a Hangul filler", "a\u3164b", "HIDDEN"],
    ["an invisible operator", "a\u2061b", "HIDDEN"],
    ["a bidi override", "a\u202Eb", "BIDI"],
    ["an em space", "a\u2003b", "SPACE"],
  ])("catches %s", (_, text, kind) => {
    expect(names(fileOf([`+${text}`]))).toEqual([kind]);
  });

  it("doesn't let a long tag run pass as a flag", () => {
    const smuggled = "\u{1F3F4}" + "\u{E0041}".repeat(10);
    expect(hiddenKinds(hiddenLines(fileOf([`+${smuggled}`])))).toEqual([{ name: "TAG", point: "U+E0041", count: 3 }]);
  });

  it("skips folded generated files", () => {
    expect(names(fileOf(["+a\u00A0b"], { noise: "Generated file" }))).toEqual([]);
  });
});
