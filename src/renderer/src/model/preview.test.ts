import { describe, expect, it } from "vitest";
import type { FileDiff, Hunk } from "../../../shared/types";
import { renderMarkdown } from "./markdown";
import { blobUrl, changeMarks, previewOf, resolveRelative } from "./preview";

function file(path: string, extra: Partial<FileDiff> = {}): FileDiff {
  return { path, status: "modified", binary: false, additions: 0, deletions: 0, hunks: [], ...extra };
}

describe("previewOf", () => {
  it("always previews binary images and offers it for SVG and Markdown", () => {
    expect(previewOf(file("a/logo.PNG", { binary: true }))).toEqual({ kind: "image", forced: true });
    expect(previewOf(file("a/logo.png"))).toBeNull();
    expect(previewOf(file("icon.svg"))).toEqual({ kind: "image", forced: false });
    expect(previewOf(file("docs/plan.md"))).toEqual({ kind: "markdown", forced: false });
    expect(previewOf(file("docs/plan.md", { tooLarge: true }))).toBeNull();
    expect(previewOf(file("Makefile"))).toBeNull();
  });

  it("previews an image stored in Git LFS instead of diffing its pointer", () => {
    const pointer = (oid: string, size: number) => [`oid sha256:${oid.repeat(64)}`, `size ${size}`];
    const lines = [
      { kind: "ctx" as const, text: "version https://git-lfs.github.com/spec/v1", oldNo: 1, newNo: 1 },
      ...pointer("a", 10).map((text, i) => ({ kind: "del" as const, text, oldNo: i + 2 })),
      ...pointer("b", 20).map((text, i) => ({ kind: "add" as const, text, newNo: i + 2 })),
    ];
    const hunks = [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, header: "", lines }];
    expect(previewOf(file("a/logo.png", { hunks }))).toEqual({ kind: "image", forced: true });
    expect(previewOf(file("icon.svg", { hunks }))).toEqual({ kind: "image", forced: true });
    expect(previewOf(file("notes.txt", { hunks }))).toBeNull();
    const edited = [{ ...hunks[0], lines: [...lines, { kind: "add" as const, text: "not a pointer", newNo: 4 }] }];
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

const hunk: Hunk = {
  oldStart: 3,
  oldLines: 4,
  newStart: 3,
  newLines: 6,
  header: "",
  lines: [
    { kind: "ctx", text: "keep", oldNo: 3, newNo: 3 },
    { kind: "ctx", text: "", oldNo: 4, newNo: 4 },
    { kind: "del", text: "gone", oldNo: 5 },
    { kind: "del", text: "", oldNo: 6 },
    { kind: "del", text: "edit me", oldNo: 7 },
    { kind: "add", text: "edited", newNo: 5 },
    { kind: "add", text: "", newNo: 6 },
    { kind: "add", text: "- one", newNo: 7 },
    { kind: "add", text: "- two", newNo: 8 },
  ],
};
const newText = "# Title\n\nkeep\n\nedited\n\n- one\n- two\n";

describe("renderMarkdown", () => {
  it("marks blocks that hold changed lines, with their hunk and source lines", () => {
    const marks = changeMarks(file("plan.md", { hunks: [hunk] }));
    expect([...marks.added.keys()]).toEqual([5, 6, 7, 8]);
    expect([...marks.cuts.keys()]).toEqual([5]);
    const html = renderMarkdown(newText, marks, () => null);
    expect(html).toContain('<h1 data-from="1" data-to="1">Title</h1>');
    expect(html).toContain('<p data-from="3" data-to="3">keep</p>');
    expect(html).toContain('<p data-from="5" data-to="5" class="md-chg" data-hunks="0">edited</p>');
    expect(html).toContain('<li>\n<p class="tight md-chg" data-from="7" data-to="7" data-hunks="0">one</p>\n</li>');
  });

  it("marks a removed block on the block that follows it", () => {
    const cut: Hunk = {
      oldStart: 1,
      oldLines: 5,
      newStart: 1,
      newLines: 3,
      header: "",
      lines: [
        { kind: "ctx", text: "a", oldNo: 1, newNo: 1 },
        { kind: "ctx", text: "", oldNo: 2, newNo: 2 },
        { kind: "del", text: "gone", oldNo: 3 },
        { kind: "del", text: "", oldNo: 4 },
        { kind: "ctx", text: "b", oldNo: 5, newNo: 3 },
      ],
    };
    const html = renderMarkdown("a\n\nb\n", changeMarks(file("x.md", { hunks: [cut] })), () => null);
    expect(html).toContain('<p data-from="1" data-to="1">a</p>');
    expect(html).toContain('<p data-from="3" data-to="3" class="md-cut" data-hunks="0">b</p>');
  });

  it("marks removed lines at the end of the file on the last block", () => {
    const tail: Hunk = {
      oldStart: 2,
      oldLines: 3,
      newStart: 2,
      newLines: 1,
      header: "",
      lines: [
        { kind: "ctx", text: "a", oldNo: 2, newNo: 2 },
        { kind: "del", text: "", oldNo: 3 },
        { kind: "del", text: "b", oldNo: 4 },
      ],
    };
    const html = renderMarkdown("\na\n", changeMarks(file("x.md", { hunks: [tail] })), () => null);
    expect(html).toContain('<p data-from="2" data-to="2" class="md-cut-end" data-hunks="0">a</p>');
  });

  it("marks an edited line no block renders on the block before it", () => {
    const ref: Hunk = {
      oldStart: 1,
      oldLines: 3,
      newStart: 1,
      newLines: 3,
      header: "",
      lines: [
        { kind: "ctx", text: "see [docs]", oldNo: 1, newNo: 1 },
        { kind: "ctx", text: "", oldNo: 2, newNo: 2 },
        { kind: "del", text: "[docs]: https://good.dev", oldNo: 3 },
        { kind: "add", text: "[docs]: https://evil.dev", newNo: 3 },
      ],
    };
    const html = renderMarkdown("see [docs]\n\n[docs]: https://evil.dev\n", changeMarks(file("x.md", { hunks: [ref] })), () => null);
    expect(html).toContain('class="md-chg" data-hunks="0"');
    expect(html).not.toContain("md-cut");
  });

  it("lists every hunk inside one block", () => {
    const body = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`);
    const edit = (n: number): Hunk => ({
      oldStart: n,
      oldLines: 1,
      newStart: n,
      newLines: 1,
      header: "",
      lines: [
        { kind: "del", text: "old", oldNo: n },
        { kind: "add", text: body[n - 2], newNo: n },
      ],
    });
    const text = ["```", ...body, "```", ""].join("\n");
    const html = renderMarkdown(text, changeMarks(file("x.md", { hunks: [edit(2), edit(13)] })), () => null);
    expect(html).toContain('class="md-chg" data-hunks="0 1"');
  });

  it("escapes raw HTML and shows images from outside the repo as their alt text", () => {
    const html = renderMarkdown(
      "<script>alert(1)</script>\n\n![logo](img/a.png) ![remote <b>](https://e.x/b.png) ![planted](moire://blob/?root=/tmp/x)\n",
      null,
      (src) => (src.startsWith("img/") ? `moire://blob/?path=${src}` : null),
    );
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain('src="moire://blob/?path=img/a.png"');
    expect(html).toContain('<span class="md-img-off">remote &lt;b&gt;</span>');
    expect(html).toContain('<span class="md-img-off">planted</span>');
    expect(html).not.toContain("https://e.x");
    expect(html).not.toContain("/tmp/x");
  });
});
