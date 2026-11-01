// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { diffHunk } from "../../../main/test-repo";
import type { FileDiff } from "../../../shared/types";
import { markdownPage, plainPage, renderMarkdown, slug } from "./markdown";
import { tooBigToRender } from "./preview";
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

  it("reads a self-closed opening tag as an opening tag", () => {
    expect(renderMarkdown("<div/>x</div>\n", null, () => null)).toMatch(/^<div[^>]*><div[^>]*>x<\/div>\s*<\/div>\s*$/);
  });

  it("leaves HTML that spans several blocks unwrapped", () => {
    const html = renderMarkdown("<details>\n<summary>Keys</summary>\n\n- one\n\n</details>\n", null, () => null);
    expect(html).toMatch(/^<details>\n<summary>Keys<\/summary>\n<ul/);
    expect(html).toContain("</ul>\n</details>");
  });
});

describe("markdownPage", () => {
  const page = (text: string) => markdownPage(text, null, () => null);

  it("draws task boxes the file can't fake", () => {
    const el = page('- [x] done\n- [ ] todo\n- plain\n\n<span class="md-box on"></span>\n');
    const items = [...el.querySelectorAll("li")];
    expect(items.map((li) => li.classList.contains("md-task"))).toEqual([true, true, false]);
    expect(items[0].querySelector(".md-box.on")).not.toBeNull();
    expect(items[1].querySelector(".md-box:not(.on)")).not.toBeNull();
    expect(items[0].textContent.trim()).toBe("done");
    expect(el.querySelectorAll(".md-box")).toHaveLength(2);
  });

  it("turns GitHub alerts into titled blocks", () => {
    const el = page("> [!WARNING]\n> Watch out\n\n> [!NOPE]\n> stays\n");
    const [alert, plain] = el.querySelectorAll("blockquote");
    expect(alert.className).toBe("md-alert md-alert-warning");
    expect(alert.querySelector(".md-alert-title")!.textContent).toBe("Warning");
    expect(alert.textContent).not.toContain("[!");
    expect(plain.className).toBe("");
  });

  it("links footnotes under names that survive the sanitizer, and keeps blocks in order", () => {
    const el = page("Claim.[^1]\n\n[^1]: The source.\n\nAfter.\n");
    const ref = el.querySelector("sup a")!;
    expect(ref.getAttribute("href")).toBe("#fn1");
    expect(el.querySelector('[data-anchor="fn1"]')!.textContent).toContain("The source.");
    expect(el.querySelector("section.md-footnotes")).not.toBeNull();
    expect(el.querySelector("[id]")).toBeNull();
  });

  it("anchors headings the way GitHub does", () => {
    const seen = new Map<string, number>();
    expect(slug("Rate limiter: rollout!", seen)).toBe("rate-limiter-rollout");
    expect(slug("Rate limiter: rollout", seen)).toBe("rate-limiter-rollout-1");
    expect(page("## Two `words`\n").querySelector("h2")!.getAttribute("data-anchor")).toBe("two-words");
  });

  it("boxes fences into lines with their language", () => {
    const el = page("```ts\nconst a = 1;\n\nnext();\n```\n");
    expect(el.querySelectorAll(".md-fence .md-ln")).toHaveLength(3);
    expect(el.querySelector("code")!.getAttribute("data-lang")).toBe("ts");
    expect(el.querySelector(".md-tools")!.textContent).toContain("ts");
  });

  it("tags images GitHub shows for one colour scheme only", () => {
    const el = markdownPage("![a](x.gif#gh-dark-mode-only) ![b](y.gif#gh-light-mode-only) ![c](z.gif)\n", null, (src) => `moire://${src}`);
    expect([...el.querySelectorAll("img")].map((img) => img.className)).toEqual(["md-only-dark", "md-only-light", ""]);
  });

  it("leaves notes alone", () => {
    const html = renderMarkdown("- [x] done\n\n> [!NOTE]\n> hi\n\n```ts\nx\n```\n", null, () => null);
    expect(html).toContain("[x] done");
    expect(html).toContain("[!NOTE]");
    expect(html).not.toContain("md-");
  });
});

describe("front matter", () => {
  const page = (text: string) => markdownPage(text, null, () => null);

  it("reads as a block of YAML, not a heading", () => {
    const out = page("---\nname: x\ndescription: y\n---\n\n# Title\n");
    expect(out.querySelectorAll("h1, h2")).toHaveLength(1);
    expect(out.querySelector("code[data-lang='yaml']")!.textContent).toContain("description: y");
    expect(out.querySelector("code")!.dataset.from).toBe("1");
    expect(out.querySelector("h1")!.dataset.from).toBe("6");
  });

  it("leaves a rule and a setext heading alone", () => {
    expect(page("---\n\ntext\n---\n").querySelector("hr")).not.toBeNull();
    expect(page("---\nno colon here\n---\n").querySelector("h2")).not.toBeNull();
  });
});

describe("tables", () => {
  it("keeps column alignment without keeping style attributes", () => {
    const cells = markdownPage("| a | b |\n| :-: | --: |\n| 1 | 2 |\n", null, () => null).querySelectorAll("td");
    expect(cells[0].className).toBe("md-align-center");
    expect(cells[1].className).toBe("md-align-right");
    expect(cells[1].hasAttribute("style")).toBe(false);
  });
});

describe("text a file tries to hide", () => {
  const page = (text: string) => markdownPage(text, null, () => null);

  it.each([
    "<!-- never closed",
    "<div>\n<!-- never closed",
    '<div title="never closed',
    "<script>\nnever closed",
    "<style>\nnever closed",
    "<?php never closed",
  ])("keeps the page after %j", (opener) => {
    const shown = page(`# T\n\n${opener}\n\nthe rest of the page\n`).textContent;
    expect(shown).toContain("the rest of the page");
  });

  it("keeps the page after a raw-text tag left open in a sentence", () => {
    const shown = page("one <title>two\n\nthe rest of the page\n").textContent;
    expect(shown).toContain("<title>two");
    expect(shown).toContain("the rest of the page");
  });

  it("leaves a closed comment out of the page", () => {
    expect(page("<!-- note -->\n\nbody\n").textContent).not.toContain("note");
  });

  it.each([
    ["rp", "<ruby>a<rp>secret</rp><rt>b</rt></ruby>"],
    ["datalist", "<datalist><option>secret</option></datalist>"],
    ["audio", "<audio>secret</audio>"],
    ["video", "<video>secret</video>"],
    ["canvas", "<canvas>secret</canvas>"],
    ["meter", "<meter>secret</meter>"],
    ["progress", "<progress>secret</progress>"],
    ["marquee", '<marquee width="0">secret</marquee>'],
  ])("shows the text inside %s", (tag, html) => {
    const shown = page(`${html}\n`);
    expect(shown.textContent).toContain("secret");
    expect(shown.querySelector(tag)).toBeNull();
  });

  it("drops popover, which hides an element until a script opens it", () => {
    const shown = page("<div popover>secret</div>\n");
    expect(shown.textContent).toContain("secret");
    expect(shown.querySelector("[popover]")).toBeNull();
  });
});

describe("line numbers", () => {
  it("counts lines the way git does when a file holds a bare CR", () => {
    const text = "Intro\rmore\n\nfirst\n\nsecond\n";
    const html = renderMarkdown(text, changeMarks(file("x.md", { hunks: [diffHunk(5, ["-old", "+second"])] })), () => null);
    expect(html).toContain('<p data-from="3" data-to="3">first</p>');
    expect(html).toContain('<p data-from="5" data-to="5" class="md-chg" data-hunks="0">second</p>');
  });

  it("leaves CRLF line endings alone", () => {
    expect(renderMarkdown("one\r\n\r\ntwo\r\n", null, () => null)).toContain('<p data-from="3" data-to="3">two</p>');
  });
});

describe("hostile files", () => {
  const LIMIT_MS = 1500;
  const timed = (text: string) => {
    const started = performance.now();
    markdownPage(text, null, () => null);
    return performance.now() - started;
  };

  it.each([
    ["tags that never end", `<div ${"<a b ".repeat(100_000)}`],
    ["comments that never end", "<!--".repeat(125_000)],
    ["comments that never end in a sentence", "x <!-- ".repeat(70_000)],
    ["processing instructions that never end", "x <? ".repeat(100_000)],
    ["inline footnotes", "^[x] ".repeat(100_000)],
  ])("renders 500 KB of %s in time", (_, text) => {
    expect(timed(text)).toBeLessThan(LIMIT_MS);
  });

  it("still reads an inline comment that does end", () => {
    expect(markdownPage("one <!-- hidden --> two\n", null, () => null).textContent).not.toContain("hidden");
  });

  it("still renders footnotes in an ordinary file", () => {
    expect(markdownPage("one[^a]\n\n[^a]: note\n", null, () => null).querySelector(".md-footnotes")).not.toBeNull();
  });

  it("gives up on rendering past the limit and keeps the text", () => {
    const text = "<b>a</b>\n".repeat(100_000);
    expect(tooBigToRender(text)).toBe(true);
    expect(tooBigToRender("short")).toBe(false);
    expect(tooBigToRender("a\n".repeat(11_000))).toBe(true);
    expect(tooBigToRender(null)).toBe(false);
    const box = document.createElement("div");
    box.innerHTML = plainPage(text);
    expect(box.querySelector("pre")!.textContent).toBe(text);
    expect(box.querySelector("b")).toBeNull();
  });
});
