import { expect, type Page, test } from "@playwright/test";
import { fileChapters, gitIn, harness, lines, numbered, staged, writeNotes } from "./harness";

const { changedRepo, editedRepo, git, idle, launch, launchFresh, resize, shots } = harness();
let repo: string;
let page: Page;

const { body, edit } = numbered(80);

const NOTES = {
  asked: "Make the limits configurable.",
  summary: "Moves the limits into `config.ts`, so tests can lower them.",
  decisions: ["Kept the old defaults, because nothing asked to change them."],
  sections: [
    {
      title: "Where the limits live",
      before: "Hardcoded `3` in each file.",
      after: "| limit | default |\n| --- | --- |\n| read | 3 |\n",
    },
  ],
  chapters: [
    {
      title: "Limits move to config",
      text: "One place to change them.",
      sections: [{ body: "Restart to apply." }],
      ranges: [
        { path: "a.ts", lines: [4, 4], note: "The read limit moves first." },
        { path: "a.ts", lines: [11, 11] },
        { path: "b.ts", lines: [6, 6], note: "The write limit needs a restart.", warn: true },
      ],
    },
    { title: "Tests", text: "Lower both limits.", skim: true, ranges: ["a.test.ts"] },
    { title: "Reformat", text: "Indented to match.", ranges: ["format.ts"] },
    { title: "Callers", text: "The cached value goes away.", ranges: [{ path: "a.ts", lines: [61, 61] }] },
  ],
};

const CHAPTERS = { chapters: NOTES.chapters };

test.beforeAll(async () => {
  repo = editedRepo(
    {
      "a.ts": [lines(body), lines(edit(3, 10, 60))],
      "b.ts": [lines(body), lines(edit(5))],
      "a.test.ts": [lines(body), lines(edit(1))],
      "format.ts": ["a();\nb();\n", "  a();\n  b();\n"],
    },
    NOTES,
  );
  ({ page } = await launch(repo));
});

test("the brief opens once, sums up the change, and starts the walk", async () => {
  const brief = page.locator(".brief");
  await expect(brief).toBeVisible();
  await expect(page.locator(".notes-panel")).toHaveCount(0);
  await expect(page.locator(".main")).toHaveCount(0);
  await expect(brief.locator(".brief-asked")).toHaveText("Make the limits configurable.");
  await expect(brief.locator(".brief-lead")).toHaveText("Moves the limits into config.ts, so tests can lower them.");
  await expect(brief.locator(".brief-calls li").first()).toContainText("Kept the old defaults");
  await expect(brief.locator(".brief-checks li")).toContainText("The write limit needs a restart.");
  await expect(brief.locator(".brief-chapter .brief-size")).toHaveText(["6 lines", "Skim, 2 lines", "Whitespace only", "2 lines"]);
  await expect(brief.locator(".brief-tally li")).toHaveText(["8 lines to read", "6 to skim", "1 chapter to check"]);
  await shots("brief");

  await expect(brief.locator(".note-side.a")).toContainText("Hardcoded 3 in each file.");
  await expect(brief.locator(".note-side.b td").first()).toHaveText("read");
  await expect(brief.locator(".brief-chapter .note-section")).toContainText("Restart to apply.");

  await page.keyboard.press("s");
  await expect(brief).toHaveCount(0);
  await idle();
  expect(staged(repo)).toEqual([]);

  await page.keyboard.press("i");
  await expect(brief).toBeVisible();
  await brief.getByRole("button", { name: /Start the walkthrough/ }).click();
  await expect(brief).toHaveCount(0);
  await expect(page.locator(".caption-text")).toHaveText("The read limit moves first.");

  await page.keyboard.press("i");
  await expect(brief).toBeVisible();
  await expect(brief.getByRole("button", { name: /Start the walkthrough|Skip to the diff/ })).toHaveCount(0);
  await brief.getByRole("button", { name: /Back to the walkthrough/ }).click();
  await expect(page.locator(".caption-text")).toHaveText("The read limit moves first.");

  writeNotes(repo, { ...NOTES, asked: "Reworded.", chapters: NOTES.chapters.with(3, { ...NOTES.chapters[3], title: "Callers, reworded" }) });
  await expect(page.locator(".chapter-name").nth(3)).toHaveText("Callers, reworded");
  await expect(brief).toHaveCount(0);
});

test("a reload keeps the walk's place, and the brief opens for new notes, once each", async () => {
  const panel = page.locator(".notes-panel");
  await page.reload();
  await expect(panel).toBeVisible();
  await expect(page.locator(".brief")).toHaveCount(0);
  await expect(page.locator(".stop.is-current").first()).toHaveText("a.ts:4");

  await page.evaluate(() => localStorage.removeItem("moire.walks"));
  await page.reload();
  await expect(panel).toBeVisible();
  writeNotes(repo, { ...NOTES, asked: "Something else." });
  await expect(page.locator(".brief-asked")).toHaveText("Something else.");
  await page.keyboard.press("Escape");
  await expect(panel).toBeVisible();
});

test("notes that only list chapters don't open the brief by themselves", async () => {
  writeNotes(repo, CHAPTERS);
  await expect(page.locator(".chapter")).toHaveCount(4);
  await expect(page.locator(".brief")).toHaveCount(0);
  await page.locator(".notes-panel").getByRole("button", { name: "Brief" }).click();
  await expect(page.locator(".brief")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".brief")).toHaveCount(0);
});

test("hints off hides the walk's keys and leaves arrows, and with them on a walk adds stage chapter to the status bar", async () => {
  const stageChapter = page.locator('.status [data-command="stageChapter"]');
  await page.keyboard.press("i");
  await expect(page.locator(".brief-start")).toBeVisible();
  await expect(page.locator(".brief-start kbd")).toBeHidden();
  await expect(page.locator('.status [data-command="nextNote"]')).toContainText("start");
  await expect(page.locator('.status [data-command="nextHunk"]')).toHaveCount(0);

  await page.keyboard.press("?");
  await page.getByRole("checkbox", { name: "Show shortcuts on buttons" }).setChecked(true);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(stageChapter).toHaveCount(0);
  await page.locator(".chapter-head").first().click();
  await expect(stageChapter).toContainText("stage chapter");
  await expect(page.locator(".caption-keys kbd").first()).toBeVisible();
  await expect(page.locator(".caption-keys .step-arrow").first()).toBeHidden();
  await expect(page.locator(".chapter-stage kbd")).toBeVisible();
});

test("a step keeps its sentence across its ranges, and next passes over skim chapters", async () => {
  const caption = page.locator(".caption-text");
  const now = page.locator(".row.note-now .ln.b:not(.del)");

  await page.locator(".chapter-head").first().click();
  await expect(caption).toHaveText("The read limit moves first.");
  await expect(now).toHaveText(["4", "11"]);
  await expect(page.locator(".caption-where")).toHaveText("Chapter 1 of 4Limits move to configstep 1 of 22 places in this file");
  await expect(page.locator(".stop.is-current")).toHaveCount(2);
  await shots("step-caption");

  await page.keyboard.press(".");
  await expect(page.locator(".file.is-active .name")).toHaveText("b.ts");
  await expect(caption).toHaveText("The write limit needs a restart.");
  await expect(page.locator(".caption-where .note-warn")).toHaveText("Check this");

  await page.keyboard.press(".");
  await expect(page.locator(".caption-title")).toHaveText("Callers");
  await expect(caption).toHaveText("The cached value goes away.");
  await page.keyboard.press(".");
  await expect(page.locator(".toast")).toContainText("That was the last chapter to read. 2 left to skim: . opens the first.");
  await page.keyboard.press(".");
  await expect(page.locator(".toast.show")).toHaveCount(0);
  await expect(page.locator(".caption-title")).toHaveText("Tests");
  await expect(page.locator(".caption-where .note-skim")).toHaveText("Skim");
  await page.keyboard.press(",");
  await expect(page.locator(".file.is-active .name")).toHaveText("b.ts");
});

test("skim chapters stay one line, say who judged them, and stage from their row", async () => {
  const rows = page.locator(".chapter.is-skim");
  await expect(rows).toHaveCount(2);
  await expect(rows.locator(".note-skim")).toHaveText(["Skim", "Whitespace only"]);
  await page.getByRole("button", { name: "Stage Reformat" }).click();
  await expect.poll(() => staged(repo)).toEqual(["format.ts"]);
  await idle();
  await expect(page.locator(".chapter.is-current .chapter-title")).toContainText("Limits move to config");

  await page.locator(".chapter-head").nth(1).click();
  await expect(page.locator(".caption-title")).toHaveText("Tests");
  await page.keyboard.press("Shift+C");
  await expect.poll(() => staged(repo)).toEqual(["a.test.ts", "format.ts"]);
});

test("a restored walk lands on its step, so s acts on the hunk the caption is about", async () => {
  git("reset", "-q");
  await page.locator(".chapter-head", { hasText: "Callers" }).click();
  await expect(page.locator(".caption-title")).toHaveText("Callers");
  await page.reload();
  await expect(page.locator(".caption-title")).toHaveText("Callers");
  await expect(page.locator(".row.note-now").first()).toBeInViewport();
  await idle();
  await page.keyboard.press("s");
  await expect.poll(() => git("diff", "--cached")).toContain("+export const v60 = 600;");
  expect(
    git("diff", "--cached")
      .split("\n")
      .filter((l) => l.startsWith("@@")),
  ).toHaveLength(1);
  git("reset", "-q");
});

test("the caption's keys can be clicked, and Escape in the compare menu leaves it alone", async () => {
  await page.locator(".chapter-head").first().click();
  await expect(page.locator(".caption-text")).toHaveText("The read limit moves first.");
  await page.getByRole("button", { name: "Next step" }).first().click();
  await expect(page.locator(".caption-text")).toHaveText("The write limit needs a restart.");
  await page.getByRole("button", { name: "Previous step" }).first().click();
  await expect(page.locator(".caption-text")).toHaveText("The read limit moves first.");
  await page.locator(".picker-btn").click();
  await expect(page.locator(".picker-pop")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".picker-pop")).toHaveCount(0);
  await expect(page.locator(".caption")).toBeVisible();
});

test("the caption and its lines stay when the panel goes, and leave with Escape or its file", async () => {
  git("reset", "-q");
  await page.locator(".chapter-head").first().click();
  await expect(page.locator(".caption")).toBeVisible();
  await page.keyboard.press("Shift+I");
  await expect(page.locator(".notes-panel")).toHaveCount(0);
  await expect(page.locator(".caption")).toBeVisible();
  await expect(page.locator(".row.note-now")).not.toHaveCount(0);
  await page.keyboard.press("Shift+I");
  await page.keyboard.press("Escape");
  await expect(page.locator(".caption")).toHaveCount(0);
  await page.locator(".chapter-head").first().click();
  await expect(page.locator(".caption")).toBeVisible();
  await page.locator(".file", { hasText: "b.ts" }).click();
  await expect(page.locator(".caption")).toHaveCount(0);
});

test("the walk shows a deletion's lines, and the panel keeps up with a chapter taller than it is", async () => {
  const { body: trim } = numbered(200);
  const { body: long } = numbered(300);
  const note = "A sentence about this step that is long enough to wrap onto a few lines of the notes panel, so that the steps pile up.";
  const edge = editedRepo(
    {
      "trim.ts": [lines(trim), lines(trim.filter((_, i) => i < 100 || i >= 160))],
      "long.ts": [lines(long), lines(long.map((l, i) => (i % 40 === 5 ? `${l} // changed` : l)))],
    },
    {
      chapters: [
        { title: "Trim", ranges: [{ path: "trim.ts", lines: [101, 101], code: "export const v160 = 160;", note: "Removes the old values." }] },
        {
          title: "Long",
          text: note,
          ranges: Array.from({ length: 8 }, (_, i) => ({ path: "long.ts", lines: [i * 40 + 6, i * 40 + 6], note: `${i + 1}. ${note}` })),
        },
      ],
    },
  );
  ({ page } = await launchFresh(edge));
  await expect(page.locator(".chapter-head")).toHaveCount(2);
  await page.keyboard.press(".");
  await expect(page.locator(".caption-text")).toContainText("Removes");
  await expect(page.getByText("export const v159 = 159;").first()).toBeInViewport();
  await expect(page.getByText("export const v160 = 160;").first()).toBeInViewport();

  for (let i = 0; i < 8; i++) await page.keyboard.press(".");
  await expect(page.locator(".caption-text")).toContainText("8. A sentence");
  await expect(page.locator(".stop.is-current")).toBeInViewport({ ratio: 1 });
  await expect(page.locator(".chapter-stage")).toBeInViewport({ ratio: 1 });
});

test("a step lets go of the selection and acts on its own hunk, and on unchanged lines refuses until one is picked", async () => {
  const { body, edit } = numbered(100);
  const edge = editedRepo(
    { "a.ts": [lines(body), lines(edit(9, 47, 89))] },
    {
      chapters: [
        {
          title: "Steps",
          ranges: [
            { path: "a.ts", lines: [10, 10], note: "First." },
            { path: "a.ts", lines: [40, 55], note: "Second." },
            { path: "a.ts", lines: [65, 70], note: "Nothing changed here." },
          ],
        },
      ],
    },
  );
  const git = gitIn(edge);
  ({ page } = await launchFresh(edge));
  const caption = page.locator(".caption-text");
  await expect(page.locator(".chapter-head")).toHaveCount(1);
  await page.keyboard.press(".");
  await expect(caption).toHaveText("First.");
  await page.locator(".ln.b[data-line]", { hasText: /^10$/ }).click();
  await expect(page.locator(".sel-count")).toHaveText("1 line");
  await page.keyboard.press(".");
  await expect(caption).toHaveText("Second.");
  await expect(page.locator(".sel-count")).toHaveCount(0);
  await expect(page.locator(".row.note-now").first()).toBeInViewport();
  await page.keyboard.press("s");
  await expect.poll(() => git("diff", "--cached", "-U0")).toContain("+export const v47 = 470;");
  expect(git("diff", "--cached", "-U0")).not.toContain("v9 = 90");
  await idle();

  await expect(caption).toHaveText("Nothing changed here.");
  await expect(page.locator(".row.note-now").first()).toBeInViewport();
  await page.keyboard.press("x");
  await expect(page.locator(".toast")).toContainText("nothing here to discard");
  await page.keyboard.press("j");
  await page.keyboard.press("s");
  await expect.poll(() => git("diff", "--cached", "-U0")).toContain("+export const v89 = 890;");
  expect(git("diff", "--cached", "-U0")).not.toContain("v9 = 90");
});

test("a step back into a visited file lands on its lines", async () => {
  const wide = (i: number) => `export const v${i} = "${"wrapped ".repeat(30)}";`;
  const body = Array.from({ length: 900 }, (_, i) => wide(i));
  const step = (path: string, line: number, note: string) => ({ path, lines: [line, line], note });
  const edge = editedRepo(
    {
      "a.ts": [lines(body), lines(body.map((l, i) => (i % 20 === 5 ? `${l} // changed` : l)))],
      "b.ts": ["export const b = 1;\n", "export const b = 2;\n"],
    },
    { chapters: [{ title: "Back and forth", ranges: [step("a.ts", 886, "Late."), step("b.ts", 1, "Elsewhere."), step("a.ts", 6, "Early.")] }] },
  );
  ({ page } = await launchFresh(edge));
  await expect(page.locator(".chapter-head")).toHaveCount(1);
  for (const note of ["Late.", "Elsewhere.", "Early."]) {
    await page.keyboard.press(".");
    await expect(page.locator(".caption-text")).toHaveText(note);
  }
  await expect(page.locator(".row.note-now").first()).toBeInViewport();
});

test("staging the last chapter leaves its other steps, and one Undo takes back all of it", async () => {
  const edge = editedRepo(
    {
      "a.ts": [lines(body), lines(edit(3, 60))],
      "b.ts": [lines(body), lines(edit(3))],
    },
    {
      chapters: [
        {
          title: "Both ends",
          ranges: [
            { path: "a.ts", lines: [4, 4], note: "First." },
            { path: "a.ts", lines: [61, 61], note: "Second." },
            { path: "b.ts", lines: [4, 4], note: "Third." },
          ],
        },
      ],
    },
  );
  ({ page } = await launchFresh(edge));
  await expect(page.locator(".chapter-head")).toHaveCount(1);
  await page.keyboard.press(".");
  await expect(page.locator(".caption-text")).toHaveText("First.");
  await page.keyboard.press("Shift+C");
  await expect(page.locator(".toast")).toContainText("Staged chapter 1 in 2 files");
  await expect(page.locator(".brief-clear")).toContainText("Nothing is left unstaged.");
  await expect.poll(() => staged(edge)).toEqual(["a.ts", "b.ts"]);
  await page.keyboard.press("u");
  await expect.poll(() => staged(edge)).toEqual([]);
  await expect(page.locator(".brief")).toBeVisible();
});

test("a chapter ending just above a deletion stays open with its warning, and a reindent inside a string opened above its hunk isn't whitespace", async () => {
  const { body } = numbered(40);
  const text = ["const query = `", ...Array.from({ length: 10 }, (_, i) => `  line ${i}`), "`;", ""].join("\n");
  const edge = editedRepo(
    {
      "a.ts": [lines(body), lines(body.filter((_, i) => i !== 20))],
      "query.ts": [text, text.replace("  line 6", "    line 6")],
      "plain.ts": ["a();\nb();\n", "  a();\n  b();\n"],
    },
    {
      asked: "Tidy.",
      chapters: [
        { title: "Removed", ranges: [{ path: "a.ts", lines: [20, 20], note: "Confirm this is safe.", warn: true }] },
        { title: "Query", ranges: ["query.ts"] },
        { title: "Plain", ranges: ["plain.ts"] },
      ],
    },
  );
  ({ page } = await launchFresh(edge));
  const sizes = page.locator(".brief-chapter .brief-size");
  await expect(sizes).toHaveCount(3);
  await expect(sizes.first()).not.toHaveText("Nothing unstaged");
  await expect(sizes.nth(1)).toHaveText("2 lines");
  await expect(sizes.nth(2)).toHaveText("Whitespace only");
  await expect(page.locator(".brief-checks li")).toContainText("Confirm this is safe.");

  await page.keyboard.press("Escape");
  await expect(page.locator(".chapter-head")).toHaveCount(3);
  await expect(page.locator(".note-done")).toHaveCount(0);
  await page.keyboard.press(".");
  await page.keyboard.press("Shift+C");
  await expect(page.locator(".toast")).toContainText("stage them by hand");
});

test.describe(() => {
  const where = () => page.locator(".caption-title");
  let edge: string;

  // Escape only hides the caption, so the old walk would carry over to any chapter these notes share.
  const walkOn = async (chapters: { title: string; ranges: unknown[]; skim?: boolean }[]) => {
    gitIn(edge)("reset", "-q");
    await page.evaluate(() => localStorage.removeItem("moire.walks"));
    await page.reload();
    writeNotes(edge, { chapters });
    await expect(page.locator(".chapter-title")).toContainText(chapters.map((c) => c.title));
  };

  test.beforeAll(async () => {
    edge = changedRepo({ chapters: fileChapters });
    ({ page } = await launchFresh(edge));
  });

  test("in a small window the walk leaves the panel closed until asked for", async () => {
    await resize(900, 600);
    await page.locator(".chapter-head").first().waitFor();
    await page.keyboard.press(".");
    await expect(page.locator(".caption")).toBeVisible();
    await expect(page.locator(".notes-panel")).toHaveCount(0);
    await page.keyboard.press("Shift+I");
    await expect(page.locator(".notes-panel")).toBeVisible();
    await page.keyboard.press("Shift+I");
    await expect(page.locator(".notes-panel")).toHaveCount(0);
    await page.keyboard.press(".");
    await expect(page.locator(".caption")).toContainText("Chapter b");
    await expect(page.locator(".notes-panel")).toHaveCount(0);
    await resize(1440, 920);
    await page.keyboard.press("Shift+I");
    await expect(page.locator(".notes-panel")).toBeVisible();
  });

  test("a saved stop on a file this view no longer lists still opens a file", async () => {
    await walkOn(fileChapters);
    await page.keyboard.press(".");
    await page.keyboard.press(".");
    await expect(page.locator(".caption")).toContainText("Chapter b");
    gitIn(edge)("add", "b.ts");
    await idle();
    await page.reload();
    await idle();
    await page.reload();
    await idle();
    await expect(page.locator(".row").first()).toBeVisible();
    gitIn(edge)("reset", "-q");
  });

  test("staging the last chapter keeps the walk's place", async () => {
    await walkOn([
      { title: "Only", ranges: [{ path: "a.ts", note: "Only step." }] },
      { ...fileChapters[1], skim: true },
    ]);
    await page.keyboard.press(".");
    await expect(page.locator(".caption-text")).toHaveText("Only step.");
    await page.keyboard.press("Shift+C");
    await expect(page.locator(".toast")).toContainText("Staged chapter 1 in 1 file. That was the last chapter to read. 1 left to skim");
    await page.keyboard.press(".");
    await expect(where()).toHaveText("Chapter b");
  });

  test("the walk ends once it has opened every skim chapter", async () => {
    const [a, b, c, d] = fileChapters;
    await walkOn([a, { ...b, skim: true }, { ...c, skim: true }, d]);
    await page.keyboard.press(".");
    await expect(where()).toHaveText("Chapter a");
    await page.keyboard.press(".");
    await expect(where()).toHaveText("Chapter d");
    await page.keyboard.press(".");
    await expect(page.locator(".toast")).toContainText("2 left to skim");
    await page.keyboard.press(".");
    await expect(where()).toHaveText("Chapter b");
    await page.keyboard.press(".");
    await expect(where()).toHaveText("Chapter c");
    await page.keyboard.press(".");
    await expect(page.locator(".brief-end")).toContainText("End of the walkthrough.4 chapters still unstaged and 2 lines in no chapter.");
    await page.keyboard.press(",");
    await expect(page.locator(".brief")).toHaveCount(0);
    await expect(where()).toHaveText("Chapter c");
  });

  test("committing mid-walk keeps the walk on its chapter, and Shift+C stages it only while it's on screen", async () => {
    await walkOn(fileChapters);
    await page.keyboard.press(".");
    await expect(where()).toContainText("Chapter a");
    await page.keyboard.press("Shift+C");
    await expect(where()).toContainText("Chapter b");
    await page.keyboard.press("Shift+C");
    await expect(where()).toContainText("Chapter c");
    expect(staged(edge)).toEqual(["a.ts", "b.ts"]);

    await page.locator(".file", { hasText: "d.ts" }).click();
    await expect(page.locator(".caption")).toHaveCount(0);
    await page.keyboard.press("Shift+C");
    await expect(page.locator(".toast")).toContainText("Open a chapter first");
    expect(staged(edge)).toEqual(["a.ts", "b.ts"]);
    await page.locator(".file", { hasText: "c.ts" }).click();

    gitIn(edge)("commit", "-qm", "first two");
    await expect(page.locator(".chapter-head")).toHaveCount(3);
    await expect(where()).toContainText("Chapter c");
    await page.keyboard.press("Shift+C");
    await expect.poll(() => staged(edge)).toEqual(["c.ts"]);
  });
});

test("next moves by step and > by place, the caption holds still, and a skim chapter can be skipped", async () => {
  const { body } = numbered(400);
  const places = [20, 100, 200, 300];
  const edge = editedRepo(
    {
      "a.ts": [lines(body), lines(body.map((l, i) => (places.includes(i) ? `${l} // changed` : l)))],
      "b.test.ts": ["a();\n", "b();\n"],
      "c.ts": ["a();\n", "b();\n"],
    },
    {
      chapters: [
        {
          title: "Spread out",
          ranges: [
            ...places.map((n, i) => ({ path: "a.ts", lines: [n + 1, n + 1], ...(i ? {} : { note: "One short sentence." }) })),
            { path: "c.ts", note: `A longer sentence that has to wrap, ${"and it goes on ".repeat(14)}until it runs well past two lines of the caption.` },
          ],
        },
        { title: "Tests", text: "Why.", skim: true, ranges: ["b.test.ts"] },
      ],
      format: 2,
    },
  );
  ({ page } = await launchFresh(edge));
  const caption = page.locator(".caption");
  const place = page.locator(".caption-place");
  await expect(page.locator(".chapter-head")).toHaveCount(2);
  await page.keyboard.press(".");
  await expect(place).toContainText("place 1 of 4");
  const height = (await caption.boundingBox())!.height;
  await page.keyboard.press(">");
  await expect(place).toContainText("place 2 of 4");
  await page.getByRole("button", { name: "Next place" }).click();
  await expect(place).toContainText("place 3 of 4");
  await page.keyboard.press("<");
  await expect(place).toContainText("place 2 of 4");
  await shots("caption-places");
  await page.evaluate(() => {
    const seen = { lost: false };
    Object.assign(window, { seen });
    new MutationObserver(() => {
      seen.lost ||= !document.querySelector(".caption");
    }).observe(document.body, { childList: true, subtree: true });
  });

  await page.keyboard.press(".");
  await expect(page.locator('.pane-h b[data-tip$="c.ts"]').first()).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { seen: { lost: boolean } }).seen.lost)).toBe(false);
  expect((await caption.boundingBox())!.height).toBe(height);
  await shots("caption-long");
  await page.keyboard.press(",");
  await expect(place).toContainText("place 1 of 4");

  await page.locator(".chapter-head").nth(1).click();
  await expect(page.locator(".caption")).toContainText("Tests");
  await shots("caption-skim");
  expect((await caption.boundingBox())!.height).toBe(height);
  await caption.getByRole("button", { name: "Skip chapter" }).click();
  await expect(page.locator(".brief-end")).toContainText("2 chapters still unstaged");
  await shots("brief-end");
  await page
    .locator(".brief-end")
    .getByRole("button", { name: /Back to the last step/ })
    .click();
  await expect(page.locator(".caption-title")).toHaveText("Tests");
});
