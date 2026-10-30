import { describe, expect, it } from "vitest";
import { diffBlocks, gaugeWidth, shortCount } from "./diffstat";

describe("diffBlocks", () => {
  it("is empty for a file with no line changes", () => {
    expect(diffBlocks(0, 0)).toEqual(["none", "none", "none", "none", "none"]);
  });

  it("gives each line its own block for small changes", () => {
    expect(diffBlocks(2, 1)).toEqual(["add", "add", "del", "none", "none"]);
  });

  it("splits five blocks by proportion for big changes", () => {
    expect(diffBlocks(300, 100)).toEqual(["add", "add", "add", "add", "del"]);
    expect(diffBlocks(1000, 0)).toEqual(["add", "add", "add", "add", "add"]);
  });

  it("keeps a block for the small side, however lopsided", () => {
    expect(diffBlocks(1000, 1)).toEqual(["add", "add", "add", "add", "del"]);
    expect(diffBlocks(1, 1000)).toEqual(["add", "del", "del", "del", "del"]);
  });
});

describe("gaugeWidth", () => {
  it("grows 3px each time the line count doubles, up to 30px", () => {
    expect([0, 1, 3, 7, 75, 511, 512, 100000].map(gaugeWidth)).toEqual([0, 3, 6, 9, 21, 27, 30, 30]);
  });
});

describe("shortCount", () => {
  it("keeps exact counts until they no longer fit the row", () => {
    expect(shortCount(9999)).toBe("9999");
    expect(shortCount(12345)).toBe("12k");
  });
});
