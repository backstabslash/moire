import { describe, expect, it } from "vitest";
import { alignBlocks, type Block } from "./blocks";

const p = (source: string): Block => ({ kind: "P", source });

describe("alignBlocks", () => {
  it("keeps a rewritten table row in its place instead of swapping it out", () => {
    const row = (source: string): Block => ({ kind: "TR", source });
    expect(alignBlocks([row("| max | 100 |"), row("| windowMs | 60000 |")], [row("| capacity | 20 |"), row("| refillPerSec | 5 |")])).toEqual([
      { a: 0, b: 0 },
      { a: 1, b: 1 },
    ]);
  });

  it("pairs identical blocks and leaves additions and removals alone", () => {
    expect(alignBlocks([p("one"), p("gone"), p("three")], [p("one"), p("three"), p("new")])).toEqual([
      { a: 0, b: 0 },
      { a: 1, b: null },
      { a: 2, b: 1 },
      { a: null, b: 2 },
    ]);
  });

  it("pairs an edited block with the one it came from, not the one in the same slot", () => {
    const a = [p("the gateway rejects bursts of traffic")];
    const b = [p("brand new intro about something else"), p("the gateway rejects sudden bursts of traffic")];
    expect(alignBlocks(a, b)).toEqual([
      { a: null, b: 0 },
      { a: 0, b: 1 },
    ]);
  });

  it("won't pair a rewrite that shares too little", () => {
    expect(alignBlocks([p("alpha beta gamma delta")], [p("one two three delta")])).toEqual([
      { a: 0, b: null },
      { a: null, b: 0 },
    ]);
  });

  it("pairs headings across levels but not across kinds", () => {
    expect(alignBlocks([{ kind: "H2", source: "## Steps to take" }], [{ kind: "H3", source: "### Steps to take now" }])).toEqual([{ a: 0, b: 0 }]);
    expect(alignBlocks([{ kind: "H2", source: "steps to take" }], [p("steps to take now")])).toEqual([
      { a: 0, b: null },
      { a: null, b: 0 },
    ]);
  });

  it("gives up on pairing a gap too big to compare", () => {
    const many = (tag: string) => Array.from({ length: 600 }, (_, i) => p(`${tag} shared words ${i}`));
    const out = alignBlocks(many("old"), many("new"));
    expect(out).toHaveLength(1200);
    expect(out.every((pair) => pair.a === null || pair.b === null)).toBe(true);
  });
});
