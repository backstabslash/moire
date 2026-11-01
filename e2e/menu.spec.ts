import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { harness } from "./harness";

const { clipboard, commitAll, initRepo, launch, shot } = harness();
let repo: string;
let app: ElectronApplication;
let page: Page;

const menu = () => page.getByRole("menu");
const items = () => menu().getByRole("menuitem");

test.beforeAll(async () => {
  repo = initRepo();
  mkdirSync(join(repo, "site"));
  writeFileSync(join(repo, "site", "old.html"), "<p>old</p>\n");
  commitAll("init");
  writeFileSync(join(repo, "site", "index.html"), "<p>hi</p>\n");
  writeFileSync(join(repo, "site", "build"), "#!/bin/sh\n");
  chmodSync(join(repo, "site", "build"), 0o755);
  rmSync(join(repo, "site", "old.html"));

  ({ app, page } = await launch(repo));
  await app.evaluate(({ shell }) => {
    shell.openPath = async () => "";
    shell.showItemInFolder = () => {};
  });
  await expect(page.locator(".file")).toHaveCount(3);
});

test("right-clicking a file copies its paths", async () => {
  await page.locator('[data-tip^="site/index.html"]').click({ button: "right" });
  await expect(menu()).toContainText("site/index.html");
  await expect(items()).toHaveText([
    "Stage file",
    "Discard file",
    "Copy relative path",
    "Copy absolute path",
    "Copy contents",
    /^Show in /,
    "Open in editor",
    "Open with default app",
  ]);
  await expect(page.locator(".file.is-menu .name")).toHaveText("index.html");
  await shot("menu-light");
  await page.keyboard.press("Escape");
  await page.keyboard.press("t");
  await page.locator('[data-tip^="site/index.html"]').click({ button: "right" });
  await shot("menu-dark");
  await page.keyboard.press("Escape");
  await page.keyboard.press("t");
  await page.locator('[data-tip^="site/index.html"]').click({ button: "right" });
  await items().filter({ hasText: "Copy relative path" }).click();
  await expect(menu()).toBeHidden();
  await expect(page.locator(".toast.show")).toContainText("Copied site/index.html");
  expect(await clipboard()).toBe("site/index.html");

  await page.locator('[data-tip^="site/index.html"]').click({ button: "right" });
  for (const _ of "123") await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  expect(await clipboard()).toBe(join(repo, "site", "index.html"));
});

test("opens documents with the default app, but not programs", async () => {
  await page.locator('[data-tip^="site/index.html"]').click({ button: "right" });
  await items().filter({ hasText: "Open with default app" }).click();
  await expect(page.locator(".toast.show")).toContainText("Opened index.html");

  await page.locator('[data-tip^="site/build"]').click({ button: "right" });
  await items().filter({ hasText: "Open with default app" }).click();
  await expect(page.locator(".toast.show")).toContainText("build is executable, so moire won't open it");
});

test("a deleted file only offers its paths, Escape closes, and the pane header has the same menu", async () => {
  await page.locator('[data-tip^="site/old.html"]').click({ button: "right" });
  await expect(items().and(page.locator(":disabled"))).toHaveText(["Copy contents", /^Show in /, "Open in editor", "Open with default app"]);
  await page.keyboard.press("Escape");
  await expect(menu()).toBeHidden();

  await page.locator('[data-tip^="site/index.html"]').click();
  await page.locator(".panes-head").click({ button: "right" });
  await items().filter({ hasText: "Copy relative path" }).click();
  expect(await clipboard()).toBe("site/index.html");
});

test("a folder in the tree copies its path without the trailing slash", async () => {
  await page.keyboard.press("a");
  await page.locator(".tree-dir", { hasText: "site" }).click({ button: "right" });
  await expect(items()).toHaveText(["Copy relative path", "Copy absolute path", /^Show in /, "Copy files here…"]);
  await items().first().click();
  expect(await clipboard()).toBe("site");
});
