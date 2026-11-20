import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { harness } from "./harness";

const { commitAll, initRepo, launch, shots } = harness();
let repo: string;
let app: ElectronApplication;
let page: Page;

const pinned = () => page.getByRole("navigation", { name: "Pinned files" });
const changed = () => page.getByRole("navigation", { name: "Changed files" });

test.beforeAll(async () => {
  repo = initRepo();
  writeFileSync(join(repo, ".gitignore"), "IDEAS.md\n");
  writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
  writeFileSync(join(repo, "guide.md"), "# Guide\n");
  commitAll("init");
  writeFileSync(join(repo, "a.ts"), "export const a = 2;\n");
  writeFileSync(join(repo, "IDEAS.md"), "# Ideas\n");
  ({ app, page } = await launch(repo));
  await expect(changed().locator(".file")).toHaveCount(1);
});

test("a file pinned from All files stays listed and open in Changed", async () => {
  await expect(pinned()).toHaveCount(0);
  await page.keyboard.press("a");
  await page.locator('[data-path="guide.md"]').click({ button: "right" });
  await page.getByRole("menuitem", { name: "Pin" }).click();
  await expect(pinned().locator(".file .name")).toHaveText("guide.md");

  await page.locator('[data-path="guide.md"]').first().click();
  await page.keyboard.press("a");
  await expect(changed()).toBeVisible();
  await expect(page.locator('.pane-h b[data-tip$="guide.md, unchanged"]')).toBeVisible();
  await expect(page.locator(".row.uni .cell")).toHaveText(["# Guide"]);
});

test("a pinned file with no changes opens whole from Changed, and survives a refresh", async () => {
  await changed().locator('[data-path="a.ts"]').click();
  await expect(page.locator(".file.is-active .name")).toHaveText("a.ts");
  await pinned().locator('[data-path="guide.md"]').click();
  await expect(page.locator(".row.uni .cell")).toHaveText(["# Guide"]);
  await page.keyboard.press("r");
  await page.keyboard.press("2");
  await expect(page.locator('.pane-h b[data-tip$="guide.md, unchanged"]')).toBeVisible();
  await page.keyboard.press("1");
  await expect(page.locator(".row.uni .cell")).toHaveText(["# Guide"]);
});

test("a changed file pinned shows its diff, and pins keep their order and folder", async () => {
  await changed().locator('[data-path="a.ts"]').click({ button: "right" });
  await page.getByRole("menuitem", { name: "Pin" }).click();
  await expect(pinned().locator(".file .name")).toHaveText(["guide.md", "a.ts"]);
  await expect(pinned().locator('[data-path="a.ts"] .kind')).toHaveText("M");
  await pinned().locator('[data-path="a.ts"]').click();
  await expect(page.locator(".cell.add")).toContainText(["export const a = 2;"]);
  await shots("pins");
});

test("pins come back after a restart, and Unpin removes them", async () => {
  await app.close();
  ({ app, page } = await launch(repo));
  await expect(pinned().locator(".file .name")).toHaveText(["guide.md", "a.ts"]);
  for (const path of ["guide.md", "a.ts"]) {
    await pinned().locator(`[data-path="${path}"]`).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Unpin" }).click();
  }
  await expect(pinned()).toHaveCount(0);
});
