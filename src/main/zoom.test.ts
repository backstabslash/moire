import { describe, expect, it } from "vitest";
import { stepZoom } from "./zoom";

describe("stepZoom", () => {
  it("walks Chrome's steps and stops at the ends", () => {
    expect(stepZoom(1, 1)).toBe(1.1);
    expect(stepZoom(1, -1)).toBe(0.9);
    expect(stepZoom(2, 1)).toBe(2);
    expect(stepZoom(0.5, -1)).toBe(0.5);
  });

  it("snaps a factor between steps to the next one", () => {
    expect(stepZoom(1.05, 1)).toBe(1.1);
    expect(stepZoom(1.05, -1)).toBe(1);
  });
});
