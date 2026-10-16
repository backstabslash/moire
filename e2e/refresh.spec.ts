import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, type ElectronApplication, expect, type Page, test } from "@playwright/test";

let repo: string;
let userData: string;
let app: ElectronApplication;
let page: Page;
const errors: string[] = [];

const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args]);
const body = Array.from({ length: 300 }, (_, i) => `export const v${i} = ${i};`);
const write = (lines: string[]) => writeFileSync(join(repo, "a.ts"), lines.join("\n") + "\n");

test.beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "moire-e2e-repo-"));
  userData = mkdtempSync(join(tmpdir(), "moire-e2e-data-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "e2e@example.com");
  git("config", "user.name", "e2e");
  write(body);
  writeFileSync(join(repo, "b.ts"), "export const b = 1;\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  write(body.map((l, i) => (i === 150 ? l.replace("= 150", "= 1500") : l)));

  app = await electron.launch({ args: [resolve("."), `--user-data-dir=${userData}`, repo], env: { ...process.env, MOIRE_HIDDEN: "1" } });
  page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  await expect(page.locator(".file")).toHaveCount(1);
});

test.afterAll(async () => {
  await app?.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(userData, { recursive: true, force: true });
});

test.afterEach(() => {
  expect(errors).toEqual([]);
});

const topLine = () =>
  page.evaluate(() => {
    const top = document.querySelector(".scroller")!.getBoundingClientRect().top;
    const cells = [...document.querySelectorAll(".cell.b")].filter((c) => c.getBoundingClientRect().top >= top);
    cells.sort((x, y) => x.getBoundingClientRect().top - y.getBoundingClientRect().top);
    return cells[0]?.textContent;
  });

test("edits made outside show up on their own, and the view stays on the same line", async () => {
  await page.keyboard.press("f");
  await page.locator(".scroller").evaluate((el) => {
    el.scrollTop = 4000;
    el.dispatchEvent(new Event("scroll"));
  });
  await expect.poll(topLine).toMatch(/^export const v\d+ = \d+;$/);
  const before = await topLine();

  write(["// header", "// more", ...body.map((l, i) => (i === 150 ? l.replace("= 150", "= 1500") : l))]);
  await expect(page.locator(".file .s-add")).toHaveText("+3");
  await expect(page.locator(".file.is-fresh")).toHaveCount(1);
  await expect.poll(topLine).toBe(before);

  writeFileSync(join(repo, "b.ts"), "export const b = 2;\n");
  await expect(page.locator(".file")).toHaveCount(2);
  git("add", "b.ts");
  await expect(page.locator(".file")).toHaveCount(1);
});

test("focus stays on its hunk when an edit adds a hunk above it", async () => {
  await page.keyboard.press("f");
  const heads = page.locator(".hunk-head");
  await expect(heads).toHaveCount(2);
  await page.keyboard.press("j");
  const focused = page.locator(".hunk-head.is-focus .hh-range");
  const before = await focused.textContent();

  write(["// header", "// more", ...body.map((l, i) => (i === 150 ? l.replace("= 150", "= 1500") : i === 80 ? l.replace("= 80", "= 800") : l))]);
  await expect(heads).toHaveCount(3);
  await expect(focused).toHaveText(before!);
});

test("a view visited earlier never shows its file list from before an outside change", async () => {
  const picker = page.locator(".picker-btn");
  await page.keyboard.press("3");
  await expect(picker).toHaveText("All since last commit");
  await page.keyboard.press("1");
  await expect(picker).toHaveText("Unstaged");
  writeFileSync(join(repo, "c.ts"), "export const c = 1;\n");
  await expect(page.locator(".file", { hasText: "c.ts" })).toHaveCount(1);

  await page.evaluate(() => {
    const w = window as unknown as { stale: number };
    w.stale = 0;
    const look = () => {
      const all = document.querySelector(".picker-btn")?.textContent === "All since last commit";
      const names = [...document.querySelectorAll(".file .name")].map((n) => n.textContent);
      if (all && !names.includes("c.ts")) w.stale++;
    };
    new MutationObserver(look).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  await page.keyboard.press("3");
  await expect(page.locator(".file", { hasText: "c.ts" })).toHaveCount(1);
  await expect(picker).toHaveText("All since last commit");
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (window as unknown as { stale: number }).stale)).toBe(0);
  await page.keyboard.press("1");
});
