import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { _electron as electron, type ElectronApplication, expect, type Page, test } from "@playwright/test";

let repo: string;
let outside: string;
let userData: string;
let app: ElectronApplication;
let page: Page;
const errors: string[] = [];

const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
const shot = (name: string) => process.env.MOIRE_SHOTS && page.screenshot({ path: join(process.env.MOIRE_SHOTS, `${name}.png`) });

function png(width: number, height: number, [r, g, b]: number[]) {
  const chunk = (type: string, data: Buffer) => {
    const out = Buffer.alloc(data.length + 12);
    out.writeUInt32BE(data.length);
    out.write(type, 4, "ascii");
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.from([0, ...Array.from({ length: width }, () => [r, g, b]).flat()]);
  const pixels = deflateSync(Buffer.concat(Array.from({ length: height }, () => row)));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", pixels), chunk("IEND", Buffer.alloc(0))]);
}

const svg = (fill: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="32"><rect width="64" height="32" fill="${fill}"/><script>alert(1)</script></svg>\n`;
const planted = () => `moire://blob/?root=${outside}&side=worktree&path=x.png`;
const plan = (step: string, tail: string) =>
  `# Plan\n\nIntro paragraph that stays.\n\n## Steps\n\n- read the code\n- ${step}\n- ship it\n\n![logo](img/logo.png) ![planted](${planted()})\n\n\`\`\`ts\nconst x = 1;\n\`\`\`\n\nOne.\n\nTwo.\n\nThree.\n${tail}`;

test.beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "moire-e2e-repo-"));
  userData = mkdtempSync(join(tmpdir(), "moire-e2e-data-"));
  outside = mkdtempSync(join(tmpdir(), "moire-e2e-outside-"));
  writeFileSync(join(outside, "x.png"), png(4, 4, [0, 0, 0]));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "e2e@example.com");
  git("config", "user.name", "e2e");
  mkdirSync(join(repo, "img"));
  writeFileSync(join(repo, "img/logo.png"), png(40, 20, [204, 34, 80]));
  writeFileSync(join(repo, "icon.svg"), svg("#cc2250"));
  writeFileSync(join(repo, "plan.md"), plan("write a test", "\nAn old note.\n"));
  writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  writeFileSync(join(repo, "img/logo.png"), png(60, 30, [10, 140, 160]));
  writeFileSync(join(repo, "icon.svg"), svg("#0a8ca0"));
  writeFileSync(join(repo, "plan.md"), plan("write the **e2e** test", ""));
  writeFileSync(join(repo, "a.ts"), "export const a = 2;\n");

  app = await electron.launch({
    args: [resolve("."), `--user-data-dir=${userData}`, repo],
    env: { ...process.env, MOIRE_HIDDEN: "1", MOIRE_PREFS: '{"theme":"dark"}' },
  });
  page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  await expect(page.locator(".file")).toHaveCount(4);
});

test.afterAll(async () => {
  await app?.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(userData, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test.afterEach(() => {
  expect(errors).toEqual([]);
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
  await page.locator(".file", { hasText: "plan.md" }).click();
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
  await expect(page.locator(".md-bar.cut.is-focus")).toHaveCSS("width", "15px");
  await page.keyboard.press("t");
  await shot("preview-markdown-light");
  await page.keyboard.press("t");
  await page.keyboard.press("m");
  await expect(page.locator(".md")).toHaveCount(0);
  await expect(page.locator(".cell.add")).toHaveCount(1);
});

test("switching themes recolours code without highlighting again", async () => {
  await page.locator(".file", { hasText: "a.ts" }).click();
  const keyword = page.locator(".cell.add span", { hasText: "export" });
  await expect(keyword).toHaveCSS("color", "rgb(242, 245, 247)");
  await page.keyboard.press("t");
  await expect(keyword).toHaveCSS("color", "rgb(23, 32, 42)");
  await page.keyboard.press("t");
});
