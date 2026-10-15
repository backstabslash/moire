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

test.beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "moire-e2e-repo-"));
  userData = mkdtempSync(join(tmpdir(), "moire-e2e-data-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "e2e@example.com");
  git("config", "user.name", "e2e");
  const body = Array.from({ length: 40 }, (_, i) => `export const v${i} = ${i};`);
  writeFileSync(join(repo, "a.ts"), body.join("\n") + "\n");
  writeFileSync(join(repo, "b.ts"), body.join("\n") + "\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  writeFileSync(join(repo, "a.ts"), body.map((l, i) => (i % 10 === 3 ? l.replace("=", "= 1 +") : l)).join("\n") + "\n");
  writeFileSync(join(repo, "b.ts"), body.slice(5).join("\n") + "\n");
  writeFileSync(join(repo, "new.ts"), "export const fresh = true;\n");

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

test("switching to an empty view and back keeps the UI alive", async () => {
  await page.keyboard.press("2");
  await expect(page.getByRole("heading", { name: "Nothing staged." })).toBeVisible();
  await page.locator(".empty-actions").getByRole("button", { name: "All files" }).click();
  await expect(page.getByRole("navigation", { name: "All files" })).toBeVisible();
  await page.keyboard.press("a");
  await expect(page.getByRole("heading", { name: "Nothing staged." })).toBeVisible();
  await page.keyboard.press("1");
  await expect(page.locator(".file")).toHaveCount(3);
  await page.locator(".picker-btn").click();
  await page.getByRole("option", { name: /^Staged/ }).click();
  await expect(page.getByRole("heading", { name: "Nothing staged." })).toBeVisible();
  await page.locator(".picker-btn").click();
  await page.getByRole("option", { name: /^All since last commit/ }).click();
  await expect(page.locator(".file")).toHaveCount(3);
});

test("keyboard walks hunks across files and toggles views", async () => {
  await expect(page.locator(".file.is-active .name")).toHaveText("a.ts");
  for (let i = 0; i < 3; i++) await page.keyboard.press("j");
  await expect(page.locator(".hunk-head.is-focus .hh-range")).toHaveText(/^−31,/);
  await page.keyboard.press("j");
  await expect(page.locator(".file.is-active .name")).toHaveText("b.ts");
  await page.keyboard.press("]");
  await expect(page.locator(".file.is-active .name")).toHaveText("new.ts");
  await page.keyboard.press("[");
  await page.keyboard.press("v");
  await expect(page.locator(".row.uni").first()).toBeVisible();
  await page.keyboard.press("f");
  await expect(page.locator(".fold")).toHaveCount(0);
  await page.keyboard.press("f");
  await page.keyboard.press("v");
  await expect(page.locator(".row.split").first()).toBeVisible();
});

test("refreshing an unchanged diff keeps the syntax colours on screen", async () => {
  const coloured = page.locator(".cell span[style]");
  await expect(coloured.first()).toBeVisible();
  const before = await coloured.count();
  await page.keyboard.press("r");
  await page.waitForTimeout(30);
  expect(await coloured.count()).toBe(before);
});
