// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { diffHunk } from "../../../main/test-repo";
import type { FileDiff } from "../../../shared/types";
import { renderMarkdown } from "./markdown";
import { changeMarks } from "./preview";

const file = (path: string, extra: Partial<FileDiff> = {}): FileDiff => ({
  path,
  status: "modified",
  binary: false,
  additions: 0,
  deletions: 0,
  hunks: [],
  ...extra,
});

const hunk = diffHunk(3, [" keep", " ", "-gone", "-", "-edit me", "+edited", "+", "+- one", "+- two"]);
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
    const cut = diffHunk(1, [" a", " ", "-gone", "-", " b"]);
    const html = renderMarkdown("a\n\nb\n", changeMarks(file("x.md", { hunks: [cut] })), () => null);
    expect(html).toContain('<p data-from="1" data-to="1">a</p>');
    expect(html).toContain('<p data-from="3" data-to="3" class="md-cut" data-hunks="0">b</p>');
  });

  it("marks removed lines at the end of the file on the last block", () => {
    const tail = diffHunk(2, [" a", "-", "-b"]);
    const html = renderMarkdown("\na\n", changeMarks(file("x.md", { hunks: [tail] })), () => null);
    expect(html).toContain('<p data-from="2" data-to="2" class="md-cut-end" data-hunks="0">a</p>');
  });

  it("marks an edited line no block renders on the block before it", () => {
    const ref = diffHunk(1, [" see [docs]", " ", "-[docs]: https://good.dev", "+[docs]: https://evil.dev"]);
    const html = renderMarkdown("see [docs]\n\n[docs]: https://evil.dev\n", changeMarks(file("x.md", { hunks: [ref] })), () => null);
    expect(html).toContain('class="md-chg" data-hunks="0"');
    expect(html).not.toContain("md-cut");
  });

  it("lists every hunk inside one block", () => {
    const body = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`);
    const edit = (n: number) => diffHunk(n, ["-old", `+${body[n - 2]}`]);
    const text = ["```", ...body, "```", ""].join("\n");
    const html = renderMarkdown(text, changeMarks(file("x.md", { hunks: [edit(2), edit(13)] })), () => null);
    expect(html).toContain('class="md-chg" data-hunks="0 1"');
  });

  it("drops scripts and shows images from outside the repo as their alt text", () => {
    const html = renderMarkdown(
      "<script>alert(1)</script>\n\n![logo](img/a.png) ![remote <b>](https://e.x/b.png) ![planted](moire://blob/?root=/tmp/x)\n",
      null,
      (src) => (src.startsWith("img/") ? `moire://blob/?path=${src}` : null),
    );
    expect(html).not.toContain("script");
    expect(html).toContain('src="moire://blob/?path=img/a.png"');
    expect(html).toContain('<span class="md-img-off">remote &lt;b&gt;</span>');
    expect(html).toContain('<span class="md-img-off">planted</span>');
    expect(html).not.toContain("https://e.x");
    expect(html).not.toContain("/tmp/x");
  });

  it("renders raw HTML blocks with change marks, without styles or handlers", () => {
    const text =
      '<p align="center">\n  <img src="logo.png" width="96" onerror="alert(1)"> <img src="https://e.x/ci.svg" alt="CI">\n</p>\n\n<b class="x" style="color:red">bold</b>\n';
    const added = diffHunk(0, ["+", "+", "+"], 1);
    const html = renderMarkdown(text, changeMarks(file("x.md", { hunks: [added] })), (src) => (src.startsWith("https:") ? null : `moire://blob/?path=${src}`));
    expect(html).toContain('<div data-from="1" data-to="3" class="md-chg" data-hunks="0"><p align="center">');
    expect(html).toContain('<img src="moire://blob/?path=logo.png" width="96">');
    expect(html).toContain('<span class="md-img-off">CI</span>');
    expect(html).toContain("<b>bold</b>");
    expect(html).not.toMatch(/onerror|style=/);
  });

  it("drops stylesheets and colours that could hide text from the reviewer", () => {
    const html = renderMarkdown(
      '<style>p { color: white }</style>\n\n<font color="white">hidden</font>\n\n<table bgcolor="white"><tr><td bgcolor="white">cell</td></tr></table>\n',
      null,
      () => null,
    );
    expect(html).not.toContain("<style");
    expect(html).not.toMatch(/color=/);
    expect(html).toContain("hidden");
    expect(html).toContain("cell");
  });

  it("keeps inline SVG with a class from crashing the preview", () => {
    expect(renderMarkdown('<svg class="octicon" width="16"><circle r="5"/></svg> icon\n', null, () => null)).toContain('<svg width="16">');
  });

  it("shows hidden HTML and marks a changed comment or lone image on its own block", () => {
    const text = 'a\n\n<p hidden>sneaky</p>\n\n<!-- note -->\n\n<img src="logo.png">\n\n# T\n';
    const html = renderMarkdown(text, changeMarks(file("x.md", { hunks: [3, 5, 7].map((n) => diffHunk(0, ["+x"], n)) })), () => "u");
    expect(html).toContain('<div data-from="3" data-to="3" class="md-chg" data-hunks="0"><p>sneaky</p>');
    expect(html).toContain('<div data-from="5" data-to="5" class="md-chg" data-hunks="1">\n</div>');
    expect(html).toContain('<div data-from="7" data-to="7" class="md-chg" data-hunks="2"><img src="u">\n</div>');
    expect(html).toContain('<h1 data-from="9" data-to="9">T</h1>');
  });

  it("drops marks written into the file itself", () => {
    const html = renderMarkdown('<span class="md-chg" data-hunks="0" data-from="1" data-x="y">x</span>\n', null, () => null);
    expect(html).toBe('<p data-from="1" data-to="1"><span>x</span></p>\n');
  });

  it("opens a details block that holds a change, and marks its opening tag on the block inside", () => {
    const text = "<details>\n<summary>Keys</summary>\n\n- one\n\n</details>\n\n<details>\n<summary>Same</summary>\n\nkept\n\n</details>\n";
    const opened = diffHunk(1, ["+<details>"]);
    const html = renderMarkdown(text, changeMarks(file("x.md", { hunks: [opened] })), () => null);
    expect(html).toMatch(/^<details open="">/);
    expect(html).toContain('<p class="tight md-chg" data-from="4" data-to="4" data-hunks="0">one</p>');
    expect(html).toContain("<details>\n<summary>Same</summary>");
  });

  it("leaves HTML that spans several blocks unwrapped", () => {
    const html = renderMarkdown("<details>\n<summary>Keys</summary>\n\n- one\n\n</details>\n", null, () => null);
    expect(html).toMatch(/^<details>\n<summary>Keys<\/summary>\n<ul/);
    expect(html).toContain("</ul>\n</details>");
  });
});
