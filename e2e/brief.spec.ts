import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { commitAllIn, fileChapters, gitIn, harness, lines, png, staged, writeCommitNotes, writeIn, writeNotes } from "./harness";

const { changedRepo, cleanRepo, editedRepo, git, launch, launchFresh, resize, shots } = harness();
let repo: string;
let page: Page;

const SIZES = [90, 4, 60, 3, 2, 30, 2, 20, 2, 1, 1, 50, 3, 2];
const LONG_PATH = "src/renderer/src/components/settings/appearance/ThemePickerPopover.test.tsx";
const LONG_URL = `https://example.com/${"review".repeat(30)}`;
const name = (i: number) => `src/part${i}.ts`;
const fill = (n: number, text: string) => lines(Array.from({ length: n }, (_, i) => `export const ${text}${i} = ${i};`));
const oldThenNew = (n: number): [string, string] => [fill(n, "old"), fill(n, "new")];
const overflow = (selector: string) => page.locator(selector).evaluate((el) => el.scrollWidth - el.clientWidth);

const NOTES = {
  asked: "Show where the changed lines went.",
  summary: "Adds a strip that sizes each chapter, with the skim and unexplained parts told apart.",
  decisions: ["Sizes count changed lines, not hunks."],
  chapters: SIZES.map((_, i) => ({
    title: `Chapter ${i + 1}`,
    text: "One sentence on why this exists.",
    ranges: [name(i)],
    ...(i >= 12 ? { skim: true } : {}),
    ...(i === 2 || i === 11 ? { ranges: [{ path: name(i), note: "Check it.", warn: true }] } : {}),
  })),
};

test.beforeAll(async () => {
  repo = editedRepo({ ...Object.fromEntries(SIZES.map((n, i) => [name(i), oldThenNew(n)])), "src/stray.ts": oldThenNew(30) }, NOTES);
  ({ page } = await launch(repo));
});

test("the strip fits every chapter's number, and its key says what each mark means", async () => {
  await expect(page.locator(".brief")).toBeVisible();
  const parts = page.locator(".strip-part");
  await expect(parts).toHaveCount(15);
  const clipped = await parts.evaluateAll((list) => list.filter((el) => el.scrollWidth > el.clientWidth).length);
  expect(clipped).toBe(0);
  await expect(page.locator(".brief-tally li")).toHaveText(["530 lines to read", "10 to skim", "60 in no chapter", "2 chapters to check"]);
  await shots("brief-strip");
});

test("at the smallest window the strip wraps, and the page stays inside its width", async () => {
  await resize(900, 600);
  const rows = await page.locator(".strip-part").evaluateAll((list) => new Set(list.map((el) => el.getBoundingClientRect().top)).size);
  expect(rows).toBeGreaterThan(1);
  expect(await overflow(".brief-page")).toBeLessThanOrEqual(0);
  await resize(1440, 920);
});

test("with nothing left unstaged, the brief moves to Staged and keeps everything", async () => {
  git("add", "-A");
  await expect(page.locator(".picker-btn")).toHaveText("Staged");
  await expect(page.locator(".brief-clear")).toHaveCount(0);
  await expect(page.locator(".brief-strip")).toBeVisible();
  await expect(page.locator(".brief-checks li")).toHaveCount(2);
  await expect(page.locator(".brief-rail-head span").last()).toContainText("14 chapters, 12 steps");
  await expect(page.locator(".brief-size").first()).toHaveText("180 lines");
  await shots("brief-reviewed");

  await page.keyboard.press("1");
  await expect(page.locator(".brief-clear")).toContainText("Nothing is left unstaged.");
  await page
    .locator(".brief-clear")
    .getByRole("button", { name: /Open Staged/ })
    .click();
  await expect(page.locator(".brief-strip")).toBeVisible();

  await page.getByRole("button", { name: /Start the walkthrough/ }).click();
  await expect(page.locator(".brief")).toHaveCount(0);
  await expect(page.locator(".caption")).toBeVisible();
  await expect(page.locator(".toast.show")).toHaveCount(0);
});

test("in Staged with nothing staged, the brief leads back to Unstaged", async () => {
  git("reset", "-q");
  await page.keyboard.press("i");
  const clear = page.locator(".brief-clear");
  await expect(clear).toContainText("Nothing from these notes is staged yet.");
  await clear.getByRole("button", { name: /Open Unstaged/ }).click();
  await expect(page.locator(".brief-strip")).toBeVisible();
  await page.keyboard.press("Escape");
});

test("a chapter with no text lines still needs reviewing", async () => {
  const noted = editedRepo(
    { "logo.png": [png(4, 4, [1, 2, 3]), png(4, 4, [9, 8, 7])] },
    {
      asked: "Swap the logo.",
      chapters: [{ title: "New logo", text: "Why.", ranges: [{ path: "logo.png", note: "Check the colours.", warn: true }] }],
    },
  );
  const { page } = await launchFresh(noted);
  await expect(page.locator(".brief")).toBeVisible();
  await expect(page.locator(".brief-clear")).toHaveCount(0);
  await expect(page.locator(".strip-part")).toHaveCount(1);
  await expect(page.locator(".brief-tally li")).toHaveText(["1 chapter with no lines to show", "1 chapter to check"]);
  await expect(page.locator(".brief-size")).toHaveText("No lines to show");
  await expect(page.getByRole("button", { name: /Start the walkthrough/ })).toBeVisible();
  await shots("brief-lineless");
});

test("comparing several noted commits shows each commit's summary", async () => {
  const noted = cleanRepo();
  const git = gitIn(noted);
  git("checkout", "-q", "-b", "feature");
  const commit = (name: string, summary: string) => {
    writeFileSync(join(noted, `${name}.ts`), `export const ${name} = 3;\n`);
    commitAllIn(noted)(name);
    const sha = git("rev-parse", "HEAD").trim();
    const chapters = [{ title: `Chapter ${name}`, text: "Why.", ranges: [`${name}.ts`] }];
    writeCommitNotes(noted, sha, { asked: `Do ${name}.`, summary, chapters });
  };
  commit("a", "Adds the first thing.");
  commit("b", "Adds the second thing.");
  const { page } = await launchFresh([noted, "main..feature"]);
  await expect(page.locator(".brief")).toBeVisible();
  await expect(page.locator(".brief-from-summary")).toHaveText(["Adds the first thing.", "Adds the second thing."]);
  await expect(page.locator(".brief-lead")).toHaveCount(0);
});

test("a warning on a file the branch never changed still reaches the brief", async () => {
  const noted = cleanRepo();
  const git = gitIn(noted);
  git("checkout", "-q", "-b", "feature");
  writeIn(noted)("new.ts", "export const n = 1;\n");
  commitAllIn(noted)("new");
  const warned = [{ path: "a.ts", lines: [1, 1], warn: true, note: "Still calls the old endpoint." }];
  writeCommitNotes(noted, git("rev-parse", "HEAD").trim(), { asked: "Add a file.", chapters: [{ title: "Old caller", ranges: warned }] });
  const { page } = await launchFresh([noted, "main..feature"]);
  await expect(page.locator(".brief-checks li")).toContainText("Still calls the old endpoint.");
  await page.keyboard.press(".");
  await expect(page.locator(".caption-text")).toHaveText("Still calls the old endpoint.");
  await expect(page.locator(".caption")).toContainText("Check this");
});

test("a warning on lines nobody changed stays open, and the walk opens that file", async () => {
  const quiet = "first();\nsecond();\n";
  const noted = editedRepo(
    { "quiet.ts": [quiet, quiet], "other.ts": ["a();\n", "b();\n"] },
    {
      asked: "Leave this alone.",
      chapters: [{ title: "Untouched", text: "Why.", ranges: [{ path: "quiet.ts", lines: [2, 2], note: "Check this stays as it is.", warn: true }] }],
    },
  );
  const { page } = await launchFresh(noted);
  await expect(page.locator(".brief-asked")).toHaveText("Leave this alone.");
  await expect(page.locator(".brief-tally li").last()).toHaveText("1 chapter to check");
  await page.locator(".brief-checks button").click();
  await expect(page.locator(".toast")).toContainText("quiet.ts didn't change");
  await expect(page.locator(".pane-h").first()).toContainText("quiet.ts");
  await expect(page.locator(".caption-text")).toHaveText("Check this stays as it is.");
});

test.describe(() => {
  test.beforeAll(async () => {
    repo = changedRepo({ asked: "Change the letters.", chapters: fileChapters });
    ({ page } = await launchFresh(repo));
  });

  test("closing the brief keeps the layout the toolbar showed, with no toast, and split anyway survives it", async () => {
    const brief = page.locator(".brief");
    const layout = page.getByRole("group", { name: "Layout" }).locator("[aria-pressed=true]");
    await expect(brief).toBeVisible();
    await expect(layout).toContainText("Unified");

    await page.keyboard.press("Escape");
    await expect(brief).toHaveCount(0);
    await expect(page.locator(".notes-panel")).toBeVisible();
    await expect(layout).toContainText("Unified");
    await page.waitForTimeout(300);
    await expect(page.locator(".toast.show")).toHaveCount(0);

    await page.keyboard.press("v");
    await expect(layout).toContainText("Split");
    await page.keyboard.press("i");
    await expect(brief).toBeVisible();
    await expect(layout).toContainText("Split");
    await page.keyboard.press("i");
    await expect(brief).toHaveCount(0);
    await expect(layout).toContainText("Split");
    await expect(page.locator(".row.chg, .row.split").first()).toBeVisible();
  });

  test("with the brief up, the toolbar's Notes, Unified and Full file close it and apply", async () => {
    const brief = page.locator(".brief");
    const toolbar = page.locator(".toolbar");
    await page.keyboard.press("i");
    await toolbar.getByRole("button", { name: "Notes" }).click();
    await expect(brief).toHaveCount(0);
    await expect(page.locator(".notes-panel")).toBeVisible();

    await page.keyboard.press("i");
    await toolbar.getByRole("button", { name: "Unified" }).click();
    await expect(brief).toHaveCount(0);
    await expect(page.locator(".row.uni").first()).toBeVisible();

    await page.keyboard.press("i");
    await toolbar.getByRole("button", { name: "Full file" }).click();
    await expect(brief).toHaveCount(0);
    await expect(toolbar.getByRole("button", { name: "Full file" })).toHaveAttribute("aria-pressed", "true");
  });

  test("long paths and links stay inside the brief and the panel, and a tall section image is capped", async () => {
    const long = `See \`${LONG_PATH}\` and ${LONG_URL}`;
    writeIn(repo)(".git/moire/media/tall.png", png(40, 800, [9, 131, 149]));
    writeNotes(repo, {
      asked: "Handle long names.",
      decisions: [long],
      sections: [{ title: "Tall", body: "![Tall](tall.png)" }],
      chapters: [{ title: long, text: long, ranges: [{ path: "a.ts", note: long }] }],
    });
    await expect(page.locator(".brief-asked")).toHaveText("Handle long names.");
    await expect(page.locator(".brief-calls li").first()).toContainText(LONG_URL);
    expect(await overflow(".brief-rail")).toBeLessThanOrEqual(0);
    expect(await overflow(".brief-page")).toBeLessThanOrEqual(0);
    const image = page.locator(".brief-sections img");
    await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalHeight)).toBe(800);
    expect((await image.boundingBox())!.height).toBeLessThanOrEqual(360);

    await page.getByRole("button", { name: /Start the walkthrough/ }).click();
    await expect(page.locator(".step.is-current .step-note")).toContainText(LONG_URL);
    expect(await overflow(".notes-scroll")).toBeLessThanOrEqual(0);
  });

  test("clicking a chapter whose first file is fully staged stays in Unstaged, on its second file", async () => {
    writeNotes(repo, { asked: "Two files.", chapters: [{ title: "Both", text: "Why.", ranges: ["a.ts", "b.ts"] }] });
    await expect(page.locator(".brief-asked")).toHaveText("Two files.");
    gitIn(repo)("add", "a.ts");
    await expect(page.locator(".file")).toHaveCount(4);
    await page.locator(".brief-row").click();
    await expect(page.locator(".brief")).toHaveCount(0);
    await expect(page.locator(".picker-btn")).toHaveText("Unstaged");
    await expect(page.locator(".file.is-active .name")).toHaveText("b.ts");
    gitIn(repo)("reset", "-q");
    await expect(page.locator(".file")).toHaveCount(5);
  });

  test("a chapter whose lines changed stays to check, isn't whitespace, and won't stage", async () => {
    for (const name of ["b", "c"]) writeFileSync(join(repo, `${name}.ts`), `  export const ${name} = 1;\n`);
    const lost = { path: "a.ts", lines: [1, 1], code: "export const gone = 1;" };
    writeNotes(repo, {
      asked: "Some lines moved on.",
      chapters: [
        { title: "Lost", text: "Why.", ranges: [{ ...lost, note: "Look at this yourself.", warn: true }] },
        { title: "Half lost", text: "Why.", ranges: [lost, { path: "b.ts" }] },
        { title: "Reformat", text: "Why.", ranges: ["c.ts"] },
      ],
    });
    await expect(page.locator(".brief-asked")).toHaveText("Some lines moved on.");
    await expect(page.locator(".brief-chapter .brief-size")).toHaveText(["No lines to show", "2 lines", "Whitespace only"]);
    await expect(page.locator(".brief-checks li")).toContainText("Look at this yourself.");

    await page.locator(".brief-row").first().click();
    await expect(page.locator(".caption-text")).toHaveText("Look at this yourself.");
    await page.keyboard.press("Shift+C");
    await expect(page.locator(".toast")).toContainText("lines have changed since it was written");
    expect(staged(repo)).toEqual([]);
  });

  test("a change that's all skim chapters can still be walked", async () => {
    writeNotes(repo, { asked: "Only tests.", chapters: fileChapters.map((c) => ({ ...c, skim: true })) });
    await expect(page.locator(".brief-asked")).toHaveText("Only tests.");
    await page.getByRole("button", { name: "Start the walkthrough" }).click();
    await expect(page.locator(".brief")).toBeHidden();
    await expect(page.locator(".caption-where")).toContainText("Chapter a");
  });
});
