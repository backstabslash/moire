import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { harness, staged } from "./harness";

const { commitAll, idle, initRepo, launch, shot } = harness();
let repo: string;
let page: Page;

test.beforeAll(async () => {
  repo = initRepo();
  writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
  commitAll("init");
  writeFileSync(join(repo, "a.ts"), "export const a = 2;\n");
  ({ page } = await launch(repo, { prefs: { layout: "split", theme: "light" } }));
  await expect(page.locator(".hunk-head").first()).toBeVisible();
});

test("the palette finds a command, shows its key and runs it, and leaves out what only makes sense held", async () => {
  await page.keyboard.press("Control+Shift+P");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await expect(palette).toBeVisible();
  await page.keyboard.type("hold to see");
  await expect(page.getByText("No commands match.")).toBeVisible();
  await palette.getByRole("textbox").fill("split");
  await expect(palette.getByRole("option").first()).toContainText("Split or unified");
  await expect(palette.getByRole("option").first().locator("kbd")).toHaveText("v");
  await shot("palette");
  const before = await page.locator("html").getAttribute("data-layout");
  await page.keyboard.press("Enter");
  await expect(palette).toHaveCount(0);
  await expect(page.locator("html")).not.toHaveAttribute("data-layout", before!);
  await page.keyboard.press("v");
});

test("keys don't reach the view behind the palette, and Escape closes it wherever focus is", async () => {
  await page.keyboard.press("ControlOrMeta+Shift+p");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await page.keyboard.press("Tab");
  await expect(palette.getByRole("textbox")).toBeFocused();
  await palette.getByRole("textbox").evaluate((el) => el.blur());
  await page.keyboard.press("s");
  await idle();
  expect(staged(repo)).toEqual([]);
  await expect(palette).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(palette).toHaveCount(0);
});

test("closing the palette puts focus back where it was", async () => {
  await page.keyboard.press("/");
  const search = page.locator(".search input").first();
  await expect(search).toBeFocused();
  await page.keyboard.press("ControlOrMeta+Shift+p");
  await page.keyboard.press("Escape");
  await expect(search).toBeFocused();
  await page.keyboard.press("Escape");
});
