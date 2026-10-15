import { describe, expect, it } from "vitest";
import type { Hunk } from "../shared/types";
import { splice, StaleError } from "./splice";

const all = () => true;
const none = () => false;

const hunk: Hunk = {
  oldStart: 1,
  oldLines: 3,
  newStart: 1,
  newLines: 4,
  header: "",
  lines: [
    { kind: "ctx", text: "a", oldNo: 1, newNo: 1 },
    { kind: "del", text: "b", oldNo: 2 },
    { kind: "add", text: "B", newNo: 2 },
    { kind: "ctx", text: "c", oldNo: 3, newNo: 3 },
    { kind: "add", text: "d", newNo: 4 },
  ],
};
const A = "a\nb\nc\n";
const B = "a\nB\nc\nd\n";

describe("splice", () => {
  it("applies all, none or some changes toward B", () => {
    expect(splice(A, [hunk], all, "b")).toBe(B);
    expect(splice(A, [hunk], none, "b")).toBe(A);
    expect(splice(A, [hunk], (_, i) => i === 2, "b")).toBe("a\nb\nB\nc\n");
    expect(splice(A, [hunk], (_, i) => i === 1, "b")).toBe("a\nc\n");
    expect(splice(A, [hunk], (_, i) => i === 4, "b")).toBe("a\nb\nc\nd\n");
  });

  it("reverts all, none or some changes toward A", () => {
    expect(splice(B, [hunk], all, "a")).toBe(A);
    expect(splice(B, [hunk], none, "a")).toBe(B);
    expect(splice(B, [hunk], (_, i) => i === 4, "a")).toBe("a\nB\nc\n");
    expect(splice(B, [hunk], (_, i) => i === 1, "a")).toBe("a\nb\nB\nc\nd\n");
  });

  it("keeps a missing newline at end of file", () => {
    const eof: Hunk = {
      oldStart: 2,
      oldLines: 1,
      newStart: 2,
      newLines: 1,
      header: "",
      lines: [
        { kind: "del", text: "b", oldNo: 2, noNewline: true },
        { kind: "add", text: "c", newNo: 2, noNewline: true },
      ],
    };
    expect(splice("a\nb", [eof], all, "b")).toBe("a\nc");
    expect(splice("a\nc", [eof], all, "a")).toBe("a\nb");
    expect(splice("a\nb", [eof], (_, i) => i === 1, "b")).toBe("a\nb\nc");
  });

  it("adds a newline only to the end of file", () => {
    const nl: Hunk = {
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      header: "",
      lines: [
        { kind: "del", text: "x", oldNo: 1, noNewline: true },
        { kind: "add", text: "x", newNo: 1 },
      ],
    };
    expect(splice("x", [nl], all, "b")).toBe("x\n");
    expect(splice("x\n", [nl], all, "a")).toBe("x");
  });

  it("creates and empties a single-line file", () => {
    const create: Hunk = { oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, header: "", lines: [{ kind: "add", text: "only", newNo: 1 }] };
    expect(splice("", [create], all, "b")).toBe("only\n");
    expect(splice("only\n", [create], all, "a")).toBe("");
  });

  it("refuses a base that no longer matches the diff", () => {
    expect(() => splice("a\nX\nc\n", [hunk], all, "b")).toThrow(StaleError);
    expect(() => splice("a\n", [hunk], all, "b")).toThrow(StaleError);
  });
});
