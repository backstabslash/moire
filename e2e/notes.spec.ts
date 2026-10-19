import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, type ElectronApplication, expect, type Page, test } from "@playwright/test";

let repo: string;
let userData: string;
let app: ElectronApplication;
let page: Page;
const errors: string[] = [];

const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
const body = Array.from({ length: 60 }, (_, i) => `export const v${i} = ${i};`);
const edit = (...at: number[]) => body.map((l, i) => (at.includes(i) ? l.replace(`= ${i}`, `= ${i}0`) : l));
const shot = (name: string) => process.env.MOIRE_SHOTS && page.screenshot({ path: join(process.env.MOIRE_SHOTS, `${name}.png`) });
const writeNotes = (notes: unknown) => writeFileSync(join(repo, ".git", "moire", "notes.json"), JSON.stringify(notes));

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
  repo = mkdtempSync(join(tmpdir(), "moire-e2e-repo-"));
  userData = mkdtempSync(join(tmpdir(), "moire-e2e-data-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "e2e@example.com");
  git("config", "user.name", "e2e");
  for (const name of ["a.ts", "b.ts", "c.ts"]) writeFileSync(join(repo, name), body.join("\n") + "\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  writeFileSync(join(repo, "a.ts"), edit(3, 40).join("\n") + "\n");
  writeFileSync(join(repo, "b.ts"), edit(25).join("\n") + "\n");
  writeFileSync(join(repo, "c.ts"), edit(9).join("\n") + "\n");
  mkdirSync(join(repo, ".git", "moire"));
  writeNotes(NOTES);

  app = await electron.launch({ args: [resolve("."), `--user-data-dir=${userData}`, repo], env: { ...process.env, MOIRE_HIDDEN: "1" } });
  page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  await expect(page.locator(".file")).toHaveCount(3);
});

test.afterAll(async () => {
  await app?.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(userData, { recursive: true, force: true });
});

test.afterEach(() => {
  expect(errors).toEqual([]);
});

test("chapters list in reading order and show what they leave out", async () => {
  const panel = page.locator(".notes-panel");
  await expect(panel.locator(".notes-summary")).toHaveText("Moves the retry limit into config.ts so tests can lower it.");
  await expect(panel.locator(".chapter-title")).toHaveText(["The limit moves to config", "Callers"]);
  await expect(panel.locator(".uncovered button")).toHaveText(["c.ts"]);
});

test(". steps through each chapter's ranges across files", async () => {
  const panel = page.locator(".notes-panel");
  await page.keyboard.press(".");
  await expect(page.locator(".file.is-active .name")).toHaveText("b.ts");
  await expect(panel.locator(".chapter.is-current .stop-where")).toHaveText(["b.ts:26", "a.ts:4Check this"]);
  await expect(panel.locator(".stop.is-current .stop-note")).toHaveText("Read once at startup, so changing it needs a restart.");
  await expect(page.locator(".row.note-now .ln.b")).toHaveText("26");

  await page.keyboard.press(".");
  await expect(page.locator(".file.is-active .name")).toHaveText("a.ts");
  await expect(page.locator(".row.note-now .ln.b")).toHaveText("4");
  await shot("notes-light");

  await page.keyboard.press(".");
  await expect(panel.locator(".chapter.is-current .chapter-title")).toHaveText("Callers");
  await expect(page.locator(".row.note-now .ln.b")).toHaveText(["40", "41", "42"]);
  await expect(page.locator(".row.note-now").first()).toBeInViewport();
  await page.keyboard.press(".");
  await expect(page.locator(".toast")).toContainText("That was the last chapter");

  await page.keyboard.press("t");
  await page.keyboard.press(",");
  await expect(page.locator(".row.note-now .ln.b")).toHaveText("4");
  await shot("notes-dark");
  await page.keyboard.press("t");
});

test("ranges follow their code and reload when the agent rewrites notes", async () => {
  writeFileSync(join(repo, "a.ts"), ["// header", "// more", ...edit(3, 40)].join("\n") + "\n");
  await page.locator(".chapter-head").nth(1).click();
  await expect(page.locator(".row.note-now .ln.b")).toHaveText(["42", "43", "44"]);

  writeNotes({ chapters: [NOTES.chapters[0]] });
  await expect(page.locator(".chapter")).toHaveCount(1);
  await expect(page.locator(".uncovered button")).toHaveText(["a.ts", "c.ts"]);
  writeFileSync(join(repo, "a.ts"), edit(3, 40).join("\n") + "\n");
  writeNotes(NOTES);
  await expect(page.locator(".chapter")).toHaveCount(2);
});

test("I or the toolbar's Notes button hides the panel and its marks", async () => {
  const toggle = page.locator(".toolbar").getByRole("button", { name: "Notes" });
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Shift+I");
  await expect(page.locator(".notes-panel")).toHaveCount(0);
  await expect(page.locator(".row.noted")).toHaveCount(0);
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await expect(page.locator(".notes-panel")).toBeVisible();
});

test("a chapter stages all its ranges at once, then the next one opens", async () => {
  await page.locator(".chapter-head").first().click();
  await page.getByRole("button", { name: "Stage this chapter" }).click();
  await expect(page.locator(".toast")).toContainText("Staged chapter 1 in 2 files");
  await expect(page.locator(".chapter").first()).toHaveClass(/is-done/);
  await expect(page.locator(".chapter").nth(1)).not.toHaveClass(/is-done/);
  await expect(page.locator(".chapter.is-current .chapter-title")).toHaveText("Callers");
  await expect(page.locator(".row.note-now .ln.b")).toHaveText(["40", "41", "42"]);
  await expect(page.locator(".fold.has-done")).toHaveText("37 lines unchanged, 1 staged");
  expect(git("diff", "--cached", "--name-only").trim().split("\n")).toEqual(["a.ts", "b.ts"]);
  expect(git("diff", "--cached", "a.ts")).toContain("+export const v3 = 30;");
  expect(git("diff", "--cached", "a.ts")).not.toContain("v40");
});

test("a staged chapter shows a lined-up grating, and its ranges open in the Staged tab", async () => {
  const finished = page.locator(".chapter").first();
  await expect(finished.locator(".reg")).toHaveCount(0);
  expect(await finished.evaluate((el) => getComputedStyle(el).backgroundImage)).toContain("repeating-linear-gradient");
  await page.locator(".chapter-head").first().click();
  await expect(page.locator(".picker-btn")).toHaveText("Staged");
  await expect(page.locator(".file.is-active .name")).toHaveText("b.ts");
  await expect(page.locator(".row.note-now .ln.b")).toHaveText(["26"]);

  await page.keyboard.press("3");
  await page.locator(".chapter-head").first().click();
  await expect(page.locator(".chapter.is-current .stop-staged")).toHaveCount(2);
  await expect(page.locator(".chapter.is-current .stop-staged").first()).toHaveAttribute("data-tip", "Staged");
  await page.locator(".chapter-head").nth(1).click();
  await expect(page.locator(".chapter.is-current .stop-staged")).toHaveCount(0);
  await page.keyboard.press("1");
  await expect(page.locator(".picker-btn")).toHaveText("Unstaged");
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
