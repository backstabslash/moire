import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, type ElectronApplication, expect, type Page, test } from "@playwright/test";

let userData: string;
let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  userData = mkdtempSync(join(tmpdir(), "moire-e2e-data-"));
  app = await electron.launch({ args: [resolve("."), `--user-data-dir=${userData}`], env: { ...process.env, MOIRE_HIDDEN: "1", MOIRE_REPO: "" } });
  page = await app.firstWindow();
});

test.afterAll(async () => {
  await app?.close();
  rmSync(userData, { recursive: true, force: true });
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
