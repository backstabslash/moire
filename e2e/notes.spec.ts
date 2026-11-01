import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { harness, lines, numbered, png, staged, writeNotes } from "./harness";

const { commitAll, git, idle, initRepo, launch, open, resize, shot, shots } = harness();
let repo: string;
let page: Page;

const { body, edit } = numbered(60);

const NOTES = {
  summary: "Moves the retry limit into `config.ts` so tests can lower it.",
  chapters: [
    {
      title: "The limit moves to config",
      text: "Both files read the limit from one place now.",
      ranges: [
        { path: "b.ts", lines: [26, 26], note: "Read once at startup, so changing it needs a restart." },
        { path: "a.ts", lines: [4, 4], note: "Was `3`. The API allows 30 per minute.", warn: true },
      ],
    },
    {
      title: "Callers",
      text: "The one caller that cached the old value.",
      ranges: [{ path: "a.ts", lines: [40, 42], code: "export const v39 = 39;" }],
    },
  ],
};

test.beforeAll(async () => {
  repo = initRepo();
  for (const name of ["a.ts", "b.ts", "c.ts"]) writeFileSync(join(repo, name), lines(body));
  commitAll("init");
  writeFileSync(join(repo, "a.ts"), lines(edit(3, 40)));
  writeFileSync(join(repo, "b.ts"), lines(edit(25)));
  writeFileSync(join(repo, "c.ts"), lines(edit(9)));
  writeNotes(repo, NOTES);

  ({ page } = await launch(repo));
  await expect(page.locator(".file")).toHaveCount(3);
});

test("chapters list in reading order and show what they leave out", async () => {
  const panel = page.locator(".notes-panel");
  await expect(panel.locator(".notes-summary")).toHaveText("Moves the retry limit into config.ts so tests can lower it.");
  await expect(panel.locator(".chapter-title")).toHaveText(["The limit moves to config", "Callers"]);
  await expect(panel.locator(".uncovered button > span:last-of-type")).toHaveText(["c.ts"]);
});

test(". steps through each chapter's ranges across files", async () => {
  const panel = page.locator(".notes-panel");
  await page.keyboard.press(".");
  await expect(page.locator(".file.is-active .name")).toHaveText("b.ts");
  await expect(panel.locator(".chapter.is-current .stop-where")).toHaveText(["b.ts:26", "a.ts:4Check this"]);
  await expect(panel.locator(".step.is-current .step-note")).toHaveText("Read once at startup, so changing it needs a restart.");
  await expect(page.locator(".row.note-now .ln.b:not(.del)")).toHaveText("26");

  await page.keyboard.press(".");
  await expect(page.locator(".file.is-active .name")).toHaveText("a.ts");
  await expect(page.locator(".row.note-now .ln.b:not(.del)")).toHaveText("4");
  await shots("notes");

  await page.keyboard.press(".");
  await expect(panel.locator(".chapter.is-current .chapter-title")).toHaveText("Callers");
  await expect(page.locator(".row.note-now .ln.b:not(.del)")).toHaveText(["40", "41", "42"]);
  await expect(page.locator(".row.note-now").first()).toBeInViewport();
  await page.keyboard.press(".");
  await expect(page.locator(".brief-end")).toContainText("End of the walkthrough.");
  await page.keyboard.press("Escape");
});

test("ranges follow their code and reload when the agent rewrites notes", async () => {
  writeFileSync(join(repo, "a.ts"), lines(["// header", "// more", ...edit(3, 40)]));
  await page.locator(".chapter-head").nth(1).click();
  await expect(page.locator(".row.note-now .ln.b:not(.del)")).toHaveText(["42", "43", "44"]);

  writeNotes(repo, { chapters: [NOTES.chapters[0]] });
  await expect(page.locator(".chapter")).toHaveCount(1);
  await expect(page.locator(".uncovered button > span:last-of-type")).toHaveText(["a.ts", "c.ts"]);
  writeFileSync(join(repo, "a.ts"), lines(edit(3, 40)));
  writeNotes(repo, NOTES);
  await expect(page.locator(".chapter")).toHaveCount(2);
});

test("jumping to a line no chapter explains drops the step caption, and the next step brings it back", async () => {
  writeNotes(repo, { chapters: [{ title: "Only the start", ranges: [{ path: "a.ts", lines: [4, 4], note: "The first edit." }] }] });
  await expect(page.locator(".chapter")).toHaveCount(1);
  await page.locator(".chapter-head").click();
  await expect(page.locator(".caption-text")).toHaveText("The first edit.");

  await page.locator(".uncovered button", { hasText: "a.ts" }).click();
  await expect(page.locator(".caption")).toHaveCount(0);
  await expect(
    page
      .locator(".row")
      .filter({ has: page.locator(".ln.b", { hasText: /^40$/ }) })
      .first(),
  ).toBeInViewport();

  await page.locator(".chapter-head").click();
  await expect(page.locator(".caption-text")).toHaveText("The first edit.");
  writeNotes(repo, NOTES);
  await expect(page.locator(".chapter")).toHaveCount(2);
});

test("I or the toolbar's Notes button hides the panel and its marks", async () => {
  const toggle = page.locator(".toolbar").getByRole("button", { name: "Notes" });
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Shift+I");
  await expect(page.locator(".notes-panel")).toHaveCount(0);
  await expect(page.locator(".row.noted")).toHaveCount(0);
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await expect(page.locator(".notes-panel")).toBeVisible();
});

test("at the smallest window controls stay in their bars, and notes give way to the diff", async () => {
  const box = async (selector: string) => (await page.locator(selector).first().boundingBox())!;
  const right = async (selector: string) => ((b) => b.x + b.width)(await box(selector));
  await resize(900, 600);
  await page.locator(".hunk-head").first().hover();
  expect(await right(".pane-h .actions")).toBe(await right(".hh-actions"));
  expect(await right(".hh-actions")).toBeLessThanOrEqual(await right(".hunk-head"));
  expect(await right(".picker")).toBeLessThanOrEqual((await box(".tool-btn")).x);
  await page.locator(".theme-btn").click();
  const menu = await box(".theme-pop");
  expect(menu.y + menu.height).toBeLessThanOrEqual(600);
  await page.keyboard.press("Escape");

  const edge = await box(".side-resize");
  await page.mouse.move(edge.x + 2, edge.y + 200);
  await page.mouse.down();
  await page.mouse.move(600, edge.y + 200);
  await page.mouse.up();
  await expect(page.locator(".notes-panel")).toHaveCount(0);
  expect((await box(".main")).width).toBeGreaterThanOrEqual(360);
  await page.locator(".side-resize").dblclick();
  await resize(1440, 920);
  await expect(page.locator(".notes-panel")).toBeVisible();
});

test("only the open chapter shows its text, and the others keep it in a tooltip", async () => {
  await page.locator(".chapter-head").first().click();
  await expect(page.locator(".note-text")).toHaveCount(1);
  await expect(page.locator(".chapter.is-current .note-text")).toBeVisible();
  await expect(page.locator(".chapter-head").nth(1)).toHaveAttribute("data-tip", /^Callers\n/);
});

test("the panel's edge drags to resize, and a double-click resets it", async () => {
  const panel = page.locator(".notes-panel");
  const width = async () => (await panel.boundingBox())!.width;
  const before = await width();
  const edge = (await page.locator(".notes-resize").boundingBox())!;
  await page.mouse.move(edge.x + edge.width / 2, edge.y + 200);
  await page.mouse.down();
  await page.mouse.move(edge.x + edge.width / 2 - 120, edge.y + 200, { steps: 4 });
  await page.mouse.up();
  await expect.poll(width).toBe(before + 120);
  await page.locator(".notes-resize").dblclick();
  await expect.poll(width).toBe(before);
});

test("staging a chapter's hunk moves on to the next range, and other hunks leave the place alone", async () => {
  const stop = page.locator(".stop.is-current .stop-where");
  await page.locator(".chapter-head").first().click();
  await expect(page.locator(".file.is-active .name")).toHaveText("b.ts");
  await page.keyboard.press("s");
  await expect(stop).toContainText("a.ts:4");
  await expect(page.locator(".file.is-active .name")).toHaveText("a.ts");
  await expect(page.locator(".row.note-now .ln.b:not(.del)")).toHaveText("4");

  await page.locator(".file", { hasText: "c.ts" }).click();
  await expect(page.locator(".file.is-active .name")).toHaveText("c.ts");
  await page.keyboard.press("s");
  await expect.poll(() => staged(repo)).toEqual(["b.ts", "c.ts"]);
  await expect(stop).toContainText("a.ts:4");

  await open("a.ts");
  await page.locator(".stop.is-current").click();
  await expect(page.locator(".row.note-now .ln.b:not(.del)")).toHaveText("4");
  await page.keyboard.press("s");
  await expect(page.locator(".chapter.is-current .chapter-title")).toHaveText("Callers");
  await expect(page.locator(".row.note-now .ln.b:not(.del)")).toHaveText(["40", "41", "42"]);
  await expect(page.locator(".row.note-now").first()).toBeInViewport();

  git("reset", "-q");
  await expect(page.locator(".file")).toHaveCount(3);
});

test("with notes hidden, staging a chapter's hunk stays put", async () => {
  await page.locator(".chapter-head").first().click();
  await page.keyboard.press(".");
  await expect(page.locator(".file.is-active .name")).toHaveText("a.ts");
  await page.keyboard.press("Shift+I");
  await expect(page.locator(".notes-panel")).toHaveCount(0);
  await page.keyboard.press("s");
  await expect.poll(() => staged(repo)).toEqual(["a.ts"]);
  await idle();
  await expect(page.locator(".notes-panel")).toHaveCount(0);
  await expect(page.locator(".file.is-active .name")).toHaveText("a.ts");

  await page.keyboard.press("Shift+I");
  await expect(page.locator(".notes-panel")).toBeVisible();
  git("reset", "-q");
  await expect(page.locator(".file")).toHaveCount(3);
});

test("a partly staged chapter opens at its first unstaged range, in the same tab", async () => {
  git("add", "b.ts");
  await expect(page.locator(".file")).toHaveCount(2);
  await page.locator(".chapter-head").nth(1).click();
  await page.locator(".chapter-head").first().click();
  await expect(page.locator(".stop.is-current .stop-where")).toContainText("a.ts:4");
  await expect(page.locator(".file.is-active .name")).toHaveText("a.ts");
  await expect(page.getByRole("button", { name: /^Unstaged/ })).toBeVisible();
  git("reset", "-q");
  await expect(page.locator(".file")).toHaveCount(3);
});

test("a chapter stages all its ranges at once, then the next one opens", async () => {
  await page.locator(".chapter-head").first().click();
  await page.getByRole("button", { name: "Stage this chapter" }).click();
  await expect(page.locator(".toast")).toContainText("Staged chapter 1 in 2 files");
  await expect(page.locator(".chapter").first()).toHaveClass(/is-done/);
  await expect(page.locator(".chapter").first().locator(".note-done")).toHaveText("Done");
  await expect(page.locator(".chapter").nth(1)).not.toHaveClass(/is-done/);
  await expect(page.locator(".chapter.is-current .chapter-title")).toHaveText("Callers");
  await expect(page.locator(".row.note-now .ln.b:not(.del)")).toHaveText(["40", "41", "42"]);
  await expect(page.locator(".fold.has-done")).toHaveText("37 lines unchanged, 1 staged");
  expect(staged(repo)).toEqual(["a.ts", "b.ts"]);
  expect(git("diff", "--cached", "a.ts")).toContain("+export const v3 = 30;");
  expect(git("diff", "--cached", "a.ts")).not.toContain("v40");
});

test("a staged chapter's ranges open in the Staged tab", async () => {
  await page.locator(".chapter-head").first().click();
  await expect(page.locator(".picker-btn")).toHaveText("Staged");
  await expect(page.locator(".file.is-active .name")).toHaveText("b.ts");
  await expect(page.locator(".row.note-now .ln.b:not(.del)")).toHaveText(["26"]);

  await page.keyboard.press("3");
  await page.locator(".chapter-head").first().click();
  await expect(page.locator(".chapter.is-current .stop-staged")).toHaveCount(2);
  await expect(page.locator(".chapter.is-current .stop-staged").first()).toHaveAttribute("data-tip", "Staged");
  await page.locator(".chapter-head").nth(1).click();
  await expect(page.locator(".chapter.is-current .stop-staged")).toHaveCount(0);
  await page.keyboard.press("1");
  await expect(page.locator(".picker-btn")).toHaveText("Unstaged");
});

test("a chapter shows its screenshots and refuses paths outside the media folder", async () => {
  mkdirSync(join(repo, ".git", "moire", "media"), { recursive: true });
  writeFileSync(join(repo, ".git", "moire", "media", "after.png"), png(80, 40, [9, 131, 149]));
  writeFileSync(join(repo, ".git", "moire", "outside.png"), png(80, 40, [9, 131, 149]));
  const shotNotes = [{ ...NOTES.chapters[0], screenshots: [{ file: "after.png", caption: "After the change" }, "../outside.png"] }];
  writeNotes(repo, { chapters: shotNotes });
  await page.locator(".chapter-head").first().click();
  const shot = page.locator(".shot").first();
  await expect(shot.locator("figcaption")).toHaveText("After the change");
  await expect.poll(() => shot.locator("img").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(80);
  await expect(page.locator(".shot").nth(1)).toHaveText("Screenshot not found: ../outside.png");
  const blocked = await page.evaluate((root) => {
    const url = `moire://media/?root=${encodeURIComponent(root)}&file=${encodeURIComponent("../outside.png")}`;
    return new Promise((done) => {
      const img = new Image();
      img.onload = () => done("loaded");
      img.onerror = () => done("blocked");
      img.src = url;
    });
  }, repo);
  expect(blocked).toBe("blocked");
  await shot.locator("button").click();
  await expect(page.locator(".shot-view")).toBeVisible();
  await page.keyboard.press("j");
  await page.keyboard.press("Escape");
  await expect(page.locator(".shot-view")).toHaveCount(0);
  writeNotes(repo, NOTES);
  await expect(page.locator(".shot")).toHaveCount(0);
});

test("committing moves a chapter to its commit", async () => {
  git("commit", "-qm", "limit to config");
  await expect(page.locator(".chapter-title")).toHaveText(["Callers"]);

  await page.keyboard.press("4");
  await page.locator(".commit-list [role=option]").first().click();
  await expect(page.locator(".chapter-title")).toHaveText(["The limit moves to config"]);
  await expect(page.locator(".uncovered")).toHaveCount(0);
  await page.keyboard.press("1");
  await expect(page.locator(".chapter-title")).toHaveText(["Callers"]);
});

test("a long notes summary clamps to three lines and opens", async () => {
  const summary = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} about this change.`).join(" ");
  writeNotes(repo, { summary, chapters: [{ title: "One", ranges: ["a.ts"] }] });
  const text = page.locator(".notes-summary p");
  await expect(text).toContainText("Sentence number 39");
  const clamped = (await text.boundingBox())!.height;
  await shot("notes-summary");
  await page.locator(".notes-summary button").click();
  await expect(page.locator(".notes-summary button")).toHaveText("Show less");
  expect((await text.boundingBox())!.height).toBeGreaterThan(clamped);
});
