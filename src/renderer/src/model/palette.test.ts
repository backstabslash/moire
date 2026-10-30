import { describe, expect, it } from "vitest";
import { rankByLabel } from "./palette";

const items = ["Next hunk", "Stage or unstage", "Discard file", "Unstaged", "Split or unified"].map((label) => ({ label }));
const labels = (query: string) => rankByLabel(query, items).map((i) => i.label);

describe("rankByLabel", () => {
  it("keeps the order for an empty query", () => {
    expect(labels("  ")).toEqual(items.map((i) => i.label));
  });

  it("puts label starts first, then word starts, then anything inside", () => {
    expect(labels("unst")).toEqual(["Unstaged", "Stage or unstage"]);
    expect(labels("stage")).toEqual(["Stage or unstage", "Unstaged"]);
  });

  it("falls back to letters in order", () => {
    expect(labels("nxh")).toEqual(["Next hunk"]);
  });

  it("drops what doesn't match", () => {
    expect(labels("zzz")).toEqual([]);
  });
});
