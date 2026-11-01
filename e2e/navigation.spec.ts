import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { harness, lines, numbered } from "./harness";

const { commitAll, initRepo, launch, shot } = harness();
let repo: string;
let page: Page;

test.beforeAll(async () => {
  repo = initRepo();
  const { body } = numbered(40);
  writeFileSync(join(repo, "a.ts"), lines(body));
  writeFileSync(join(repo, "b.ts"), lines(body));
  commitAll("init");
  writeFileSync(join(repo, "a.ts"), lines(body.map((l, i) => (i % 10 === 3 ? l.replace("=", "= 1 +") : l))));
  writeFileSync(join(repo, "b.ts"), lines(body.slice(5)));
  writeFileSync(join(repo, "new.ts"), "export const fresh = true;\n");

  ({ page } = await launch(repo));
  await expect(page.locator(".file")).toHaveCount(3);
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
  await shot("mode-menu");
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

test("the compare picker works from the keyboard", async () => {
  const open = await page.locator(".file.is-active .name").textContent();
  await page.locator(".file.is-active").click();
  await page.locator(".picker-btn").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("option", { name: /^All since last commit/ })).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(page.getByRole("option", { name: /^Staged/ })).toBeFocused();
  await expect(page.locator(".file.is-active .name")).toHaveText(open!);
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await expect(page.locator(".picker-btn")).toContainText("Unstaged");
  await page.keyboard.press("4");
  await expect(page.getByLabel("Filter commits")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.locator(".commit-list button").first()).toBeFocused();
  await page.keyboard.press("Escape");
  await page.keyboard.press("1");
});

test("refreshing an unchanged diff keeps the syntax colours on screen", async () => {
  await expect(page.locator(".cell span[style]").first()).toBeVisible();
  const before = await page.evaluate(() => {
    const w = window as unknown as { fewest: number };
    const count = () => document.querySelectorAll(".cell span[style]").length;
    w.fewest = count();
    new MutationObserver(() => {
      w.fewest = Math.min(w.fewest, count());
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
    return w.fewest;
  });
  await page.keyboard.press("r");
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (window as unknown as { fewest: number }).fewest)).toBe(before);
});
