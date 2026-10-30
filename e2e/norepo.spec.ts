import { expect, type Page, test } from "@playwright/test";
import { harness } from "./harness";

const { launch } = harness();
let page: Page;

test.beforeAll(async () => {
  ({ page } = await launch());
});

test("without a repository, only what works is shown, and o opens the picker", async () => {
  await expect(page.getByRole("heading", { name: "Open a repository." })).toBeVisible();
  await expect(page.getByRole("group", { name: "Layout" })).toHaveCount(0);
  await expect(page.getByRole("group", { name: "Scope" })).toHaveCount(0);
  await expect(page.locator(".status .keys-list")).toHaveCount(0);
  await page.keyboard.press("o");
  await expect(page.getByLabel("Filter recent repositories")).toBeFocused();
  await expect(page.getByLabel("Filter recent repositories")).toHaveValue("");
});
