import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { harness } from "./harness";

const { git, initRepo, launch, open, shots } = harness();
let repo: string;
let page: Page;

const progress = () => page.locator(".stage-progress");

test.beforeAll(async () => {
  repo = initRepo();
  writeFileSync(join(repo, "a.ts"), "export const a = 1;\nexport const keep = true;\n");
  writeFileSync(join(repo, "b.ts"), "export const b = 1;\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  writeFileSync(join(repo, "a.ts"), "export const a = 2;\nexport const keep = true;\n");
  writeFileSync(join(repo, "b.ts"), "export const b = 2;\n");
  writeFileSync(join(repo, "c.ts"), "export const c = 1;\n");

  ({ page } = await launch(repo));
  await expect(page.locator(".file")).toHaveCount(3);
});

test("the sidebar counts staged lines as you stage them", async () => {
  await expect(progress()).toContainText("0% staged");
  for (const name of ["a.ts", "c.ts"]) {
    await open(name);
    await page.getByRole("button", { name: "Stage file" }).click();
  }
  await expect(page.locator(".file .name")).toHaveText(["b.ts"]);
  await expect(progress()).toContainText("60% staged");
  await expect(progress().locator("b")).toHaveAttribute("data-tip", /^3 of 5 changed lines\n2 of 3 files fully staged$/);
});

test("a file edited after it was staged comes back, showing only the new edits", async () => {
  writeFileSync(join(repo, "a.ts"), "export const a = 2;\nexport const keep = false;\n");
  await page.keyboard.press("r");
  await expect(page.locator(".file", { hasText: "a.ts" })).toHaveAttribute("data-tip", /staged, then changed again/);
  await expect(progress()).toContainText("42% staged");
  await page.locator(".file", { hasText: "a.ts" }).click();
  await expect(page.locator(".since")).toContainText("These are the new edits.");
  await expect(page.locator(".hunk-head")).toHaveCount(1);

  await page
    .locator(".since")
    .getByRole("button", { name: /Whole diff/ })
    .click();
  await expect(page.locator(".since")).toContainText("Staged lines are faded.");
  await expect(page.locator(".panes-head .tag-a")).toHaveAttribute("data-tip", /^HEAD/);
  await expect(page.locator(".file.is-active .name")).toHaveText("a.ts");
  await shots("progress");
  await page.locator(".since-close").click();
  await expect(page.locator(".since")).toHaveCount(0);
});

test("the All view can hide fully staged files", async () => {
  await expect(page.locator(".file .name")).toHaveText(["a.ts", "b.ts", "c.ts"]);
  await expect(page.locator(".file.is-staged .name")).toHaveText(["c.ts"]);
  await open("c.ts");
  await progress().getByLabel("Hide staged").check();
  await expect(page.locator(".file .name")).toHaveText(["a.ts", "b.ts"]);
  await expect(page.locator(".file.is-active .name")).toHaveText("a.ts");
  await progress().getByLabel("Hide staged").uncheck();
  await page.keyboard.press("1");
  await expect(progress().getByLabel("Hide staged")).toHaveCount(0);
});

test("switching views never flashes an empty view that isn't", async () => {
  for (const name of ["a.ts", "b.ts"]) {
    await open(name);
    await page.getByRole("button", { name: "Stage file" }).click();
  }
  await expect(page.locator(".empty-state h2")).toHaveText("All 3 changes are staged.");
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
  expect(await page.evaluate(() => [...(window as unknown as { seen: Set<string> }).seen])).toEqual(["All 3 changes are staged."]);
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
