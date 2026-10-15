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
const shot = (name: string) => process.env.MOIRE_SHOTS && page.screenshot({ path: join(process.env.MOIRE_SHOTS, `${name}.png`) });
const progress = () => page.locator(".stage-progress");

test.beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "moire-e2e-repo-"));
  userData = mkdtempSync(join(tmpdir(), "moire-e2e-data-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "e2e@example.com");
  git("config", "user.name", "e2e");
  writeFileSync(join(repo, "a.ts"), "export const a = 1;\nexport const keep = true;\n");
  writeFileSync(join(repo, "b.ts"), "export const b = 1;\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  writeFileSync(join(repo, "a.ts"), "export const a = 2;\nexport const keep = true;\n");
  writeFileSync(join(repo, "b.ts"), "export const b = 2;\n");
  writeFileSync(join(repo, "c.ts"), "export const c = 1;\n");

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

test("the sidebar counts staged files as you stage them", async () => {
  await expect(progress()).toContainText("0 of 3 staged");
  expect((await progress().locator(".stage-bar").boundingBox())?.height).toBe(4);
  for (const name of ["a.ts", "c.ts"]) {
    await page.locator(".file", { hasText: name }).click();
    await page.getByRole("button", { name: "Stage file" }).click();
  }
  await expect(page.locator(".file .name")).toHaveText(["b.ts"]);
  await expect(progress()).toContainText("2 of 3 staged");
});

test("a file edited after it was staged comes back marked, showing only the new edits", async () => {
  writeFileSync(join(repo, "a.ts"), "export const a = 2;\nexport const keep = false;\n");
  await page.keyboard.press("r");
  await expect(page.locator(".file", { hasText: "a.ts" }).locator(".mark-changed")).toBeVisible();
  await expect(progress()).toContainText("1 of 3 staged");
  await page.locator(".file", { hasText: "a.ts" }).click();
  await expect(page.locator(".since")).toContainText("These are the new edits.");
  await expect(page.locator(".hunk-head")).toHaveCount(1);

  await page
    .locator(".since")
    .getByRole("button", { name: /Whole diff/ })
    .click();
  await expect(page.locator(".since")).toContainText("Staged lines are faded.");
  await expect(page.locator(".pane-h").first()).toContainText("HEAD");
  await expect(page.locator(".file.is-active .name")).toHaveText("a.ts");
  await shot("progress-light");
  await page.keyboard.press("t");
  await shot("progress-dark");
  await page.keyboard.press("t");
});

test("the All view can hide fully staged files", async () => {
  await expect(page.locator(".file .name")).toHaveText(["a.ts", "b.ts", "c.ts"]);
  await expect(page.locator(".file.is-staged .name")).toHaveText(["c.ts"]);
  await page.locator(".file", { hasText: "c.ts" }).click();
  await progress().getByLabel("Hide staged").check();
  await expect(page.locator(".file .name")).toHaveText(["a.ts", "b.ts"]);
  await expect(page.locator(".file.is-active .name")).toHaveText("a.ts");
  await progress().getByLabel("Hide staged").uncheck();
  await page.keyboard.press("1");
  await expect(progress().getByLabel("Hide staged")).toHaveCount(0);
});

test("switching views never flashes an empty view that isn't", async () => {
  for (const name of ["a.ts", "b.ts"]) {
    await page.locator(".file", { hasText: name }).click();
    await page.getByRole("button", { name: "Stage file" }).click();
  }
  await expect(page.locator(".empty-state h2")).toHaveText("Nothing unstaged.");
  await page.evaluate(() => {
    const w = window as unknown as { seen: Set<string> };
    w.seen = new Set();
    new MutationObserver(() => {
      for (const h of document.querySelectorAll(".empty-state h2")) w.seen.add(h.textContent ?? "");
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  const names: Record<string, string> = { "1": "Unstaged", "2": "Staged", "3": "All since last commit" };
  for (const key of ["2", "1", "3", "1", "2"]) {
    await page.keyboard.press(key);
    await expect(page.locator(".toolbar").getByRole("button", { name: names[key], exact: true })).toBeVisible();
  }
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => [...(window as unknown as { seen: Set<string> }).seen])).toEqual(["Nothing unstaged."]);
});

test("with every file staged and hidden, the All view says so instead of opening one", async () => {
  await page.keyboard.press("3");
  await progress().getByLabel("Hide staged").check();
  await expect(page.locator(".empty-state h2")).toHaveText("Everything is staged.");
  await expect(page.locator(".file")).toHaveCount(0);
  await expect(page.locator(".panes-head")).toHaveCount(0);

  await page.keyboard.press("2");
  await page.locator(".file", { hasText: "c.ts" }).click();
  await expect(page.locator(".file.is-active .name")).toHaveText("c.ts");
  await page.keyboard.press("3");
  await expect(page.locator(".empty-state h2")).toHaveText("Everything is staged.");
  await expect(page.locator(".panes-head")).toHaveCount(0);

  await progress().getByLabel("Hide staged").uncheck();
  await expect(page.locator(".file")).toHaveCount(3);
});
