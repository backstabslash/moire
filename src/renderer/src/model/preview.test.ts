import { describe, expect, it } from "vitest";
import { diffHunk } from "../../../main/test-repo";
import type { FileDiff } from "../../../shared/types";
import { blobUrl, markdownTooBig, previewOf, readOnly, resolveRelative } from "./preview";

function file(path: string, extra: Partial<FileDiff> = {}): FileDiff {
  return { path, status: "modified", binary: false, additions: 0, deletions: 0, hunks: [], ...extra };
}

describe("markdownTooBig", () => {
  it("is only about Markdown whose text was held back for size", () => {
    expect(markdownTooBig(file("plan.md"), { a: null, b: null, hidden: true })).toBe(true);
    expect(markdownTooBig(file("plan.md"), { a: null, b: null, hidden: true, binary: true })).toBe(false);
    expect(markdownTooBig(file("plan.md"), { a: "a", b: "b", hidden: false })).toBe(false);
    expect(markdownTooBig(file("plan.md"), null)).toBe(false);
    expect(markdownTooBig(file("a.ts"), { a: null, b: null, hidden: true })).toBe(false);
  });
});

describe("previewOf", () => {
  it("always previews binary images and offers it for SVG and Markdown", () => {
    expect(previewOf(file("a/logo.PNG", { binary: true }))).toEqual({ kind: "image", forced: true });
    expect(previewOf(file("a/logo.png"))).toBeNull();
    expect(previewOf(file("logo.png", { status: "unchanged", binary: true }))).toEqual({ kind: "image", forced: true });
    expect(previewOf(file("logo.png", { status: "untracked", tooLarge: true, unread: true }))).toEqual({ kind: "image", forced: true });
    expect(previewOf(file("icon.svg"))).toEqual({ kind: "image", forced: false });
    expect(previewOf(file("docs/plan.md"))).toEqual({ kind: "markdown", forced: false });
    expect(previewOf(file("docs/plan.md", { tooLarge: true }))).toBeNull();
    expect(previewOf(file("Makefile"))).toBeNull();
  });

  it("previews an image stored in Git LFS instead of diffing its pointer", () => {
    const pointer = (oid: string, size: number) => [`oid sha256:${oid.repeat(64)}`, `size ${size}`];
    const body = [" version https://git-lfs.github.com/spec/v1", ...pointer("a", 10).map((l) => `-${l}`), ...pointer("b", 20).map((l) => `+${l}`)];
    const hunks = [diffHunk(1, body)];
    expect(previewOf(file("a/logo.png", { hunks }))).toEqual({ kind: "image", forced: true });
    expect(previewOf(file("icon.svg", { hunks }))).toEqual({ kind: "image", forced: true });
    expect(previewOf(file("notes.txt", { hunks }))).toBeNull();
    const edited = [diffHunk(1, [...body, "+not a pointer"])];
    expect(previewOf(file("a/logo.png", { hunks: edited }))).toBeNull();
  });
});

describe("blobUrl", () => {
  it("encodes the side and path, and has nothing for an empty side", () => {
    const url = blobUrl("/r", { kind: "commit", rev: "abc", label: "" }, "a b/c#.png", "k1")!;
    const parsed = new URL(url);
    expect(parsed.protocol).toBe("moire:");
    expect(Object.fromEntries(parsed.searchParams)).toEqual({ root: "/r", side: "commit", rev: "abc", path: "a b/c#.png", v: "k1" });
    expect(blobUrl("/r", { kind: "empty", label: "" }, "x.png", "k")).toBeNull();
  });
});

describe("resolveRelative", () => {
  it("resolves against the file's folder and refuses to leave the repo", () => {
    expect(resolveRelative("docs/plan.md", "img/a.png")).toBe("docs/img/a.png");
    expect(resolveRelative("docs/plan.md", "../shot%201.png?x=1")).toBe("shot 1.png");
    expect(resolveRelative("plan.md", "../a.png")).toBeNull();
    expect(resolveRelative("plan.md", "https://x.dev/a.png")).toBeNull();
    expect(resolveRelative("plan.md", "/abs.png")).toBeNull();
    expect(resolveRelative("plan.md", "data:image/png;base64,AA")).toBeNull();
    expect(resolveRelative("plan.md", "caf%E9.png")).toBeNull();
  });
});

describe("readOnly", () => {
  const big = "- line\n".repeat(11_000);

  it.each([
    ["two ordinary versions", "modified", "new", "old", false],
    ["a new file", "added", "new", null, true],
    ["a new version too big to render", "modified", big, "old", true],
    ["an old version too big to render", "modified", "new", big, true],
  ] as const)("%s", (_name, status, text, old, expected) => {
    expect(readOnly({ status }, text, old)).toBe(expected);
  });
});
