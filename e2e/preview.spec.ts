import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { harness, png } from "./harness";

const { git, initRepo, launch, open, shot, tmp } = harness();
let repo: string;
let outside: string;
let page: Page;

const svg = (fill: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="32"><rect width="64" height="32" fill="${fill}"/><script>alert(1)</script></svg>\n`;
const planted = () => `moire://blob/?root=${outside}&side=worktree&path=x.png`;
const plan = (step: string, tail: string) =>
  `# Plan\n\nIntro paragraph that stays.\n\n## Steps\n\n- read the code\n- ${step}\n- ship it\n\n![logo](img/logo.png) ![planted](${planted()})\n\n\`\`\`ts\nconst x = 1;\n\`\`\`\n\nOne.\n\nTwo.\n\nThree.\n${tail}`;

test.beforeAll(async () => {
  repo = initRepo();
  outside = tmp("outside");
  writeFileSync(join(outside, "x.png"), png(4, 4, [0, 0, 0]));
  mkdirSync(join(repo, "img"));
  writeFileSync(join(repo, "img/logo.png"), png(40, 20, [204, 34, 80]));
  writeFileSync(join(repo, "icon.svg"), svg("#cc2250"));
  writeFileSync(join(repo, "plan.md"), plan("write a test", "\nAn old note.\n"));
  writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
  writeFileSync(join(repo, "64x64.png"), png(64, 64, [204, 34, 80]));
  writeFileSync(join(repo, "data.bin"), Buffer.from([0, 1, 2, 0, 255]));
  git("add", "-A");
  git("commit", "-qm", "init");
  writeFileSync(join(repo, "img/logo.png"), png(60, 30, [10, 140, 160]));
  writeFileSync(join(repo, "icon.svg"), svg("#0a8ca0"));
  writeFileSync(join(repo, "plan.md"), plan("write the **e2e** test", ""));
  writeFileSync(join(repo, "a.ts"), "export const a = 2;\n");

  ({ page } = await launch(repo, { prefs: { theme: "dark" } }));
  await expect(page.locator(".file")).toHaveCount(4);
});

const loaded = (img: ReturnType<Page["locator"]>) =>
  expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBeGreaterThan(0);

test("a changed PNG shows both versions with their size", async () => {
  await page.locator(".file", { hasText: "logo.png" }).click();
  await loaded(page.locator(".img-side.a img"));
  await loaded(page.locator(".img-side.b img"));
  await expect(page.locator(".img-side.a figcaption")).toHaveText(/^40 × 20, \d+ B$/);
  await expect(page.locator(".img-side.b figcaption")).toHaveText(/^60 × 30, \d+ B$/);
  await shot("preview-image-dark");
  writeFileSync(join(repo, "img/logo.png"), png(80, 40, [10, 140, 160]));
  await expect(page.locator(".img-side.b figcaption")).toHaveText(/^80 × 40, \d+ B$/);
});

test("the image protocol only serves the repo that's open", async () => {
  const load = (url: string) =>
    page.evaluate(
      (src) =>
        new Promise<boolean>((done) => {
          const img = new Image();
          img.onload = () => done(true);
          img.onerror = () => done(false);
          img.src = src;
        }),
      url,
    );
  expect(await load(`moire://blob/?root=${encodeURIComponent(repo)}&side=worktree&path=img/logo.png`)).toBe(true);
  expect(await load(planted())).toBe(false);
  expect(await load(`moire://blob/?root=${encodeURIComponent(repo)}&side=worktree&path=../${outside.split("/").pop()}/x.png`)).toBe(false);
  expect(await load(`moire://blob/?root=${encodeURIComponent(repo)}&side=commit&rev=--output=x&path=img/logo.png`)).toBe(false);
});

test("m switches an SVG between its diff and the rendered images", async () => {
  await page.locator(".file", { hasText: "icon.svg" }).click();
  await expect(page.locator(".cell.add")).toHaveCount(1);
  await page.keyboard.press("m");
  await loaded(page.locator(".img-side.b img"));
  await expect(page.locator(".img-side.b figcaption")).toHaveText(/^64 × 32/);
  await page.keyboard.press("m");
  await expect(page.locator(".cell.add")).toHaveCount(1);
});

test("Markdown renders with changed and removed blocks marked, and j walks to the next hunk", async () => {
  await open("plan.md");
  await page.getByRole("button", { name: /Preview/ }).click();
  await expect(page.locator(".md h1")).toHaveText("Plan");
  await expect(page.locator(".md .md-chg")).toHaveCount(1);
  await expect(page.locator(".md .md-chg")).toHaveText("write the e2e test");
  await expect(page.locator(".md-bar.chg.is-focus")).toHaveCount(1);
  await expect(page.locator(".md-bar.cut")).toHaveCount(1);
  await expect(page.locator(".md strong")).toHaveText("e2e");
  await loaded(page.locator(".md img"));
  await expect(page.locator(".md img")).toHaveCount(1);
  await expect(page.locator(".md .md-img-off")).toHaveText("planted");
  await shot("preview-markdown-dark");
  await page.keyboard.press("j");
  await expect(page.locator(".md-bar.cut.is-focus")).toHaveCount(1);
  await page.keyboard.press("t");
  await shot("preview-markdown-light");
  await page.keyboard.press("t");
  await page.keyboard.press("m");
  await expect(page.locator(".md")).toHaveCount(0);
  await expect(page.locator(".cell.add")).toHaveCount(1);
});

test("All files shows an unchanged image as one picture, and other binaries as a note", async () => {
  await page.keyboard.press("a");
  const nav = page.getByRole("navigation", { name: "All files" });
  await nav.locator('[data-tip^="64x64.png"]').click();
  await loaded(page.locator(".img-side.b img"));
  await expect(page.locator(".img-side")).toHaveCount(1);
  await expect(page.locator(".img-side.b figcaption")).toHaveText(/^64 × 64, \d+ B$/);
  await expect(page.locator(".pane-h")).toHaveCount(1);
  await shot("preview-unchanged-dark");

  await nav.locator('[data-tip^="data.bin"]').click();
  await expect(page.locator(".note")).toHaveText("Binary file, contents not shown.");
  await expect(page.locator(".img-compare")).toHaveCount(0);
  await shot("preview-binary-dark");
  await page.keyboard.press("a");
});
