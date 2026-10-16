import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
const menu = () => page.getByRole("menu");
const items = () => menu().getByRole("menuitem");
const clipboard = () => app.evaluate(({ clipboard }) => clipboard.readText());

test.beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "moire-e2e-repo-"));
  userData = mkdtempSync(join(tmpdir(), "moire-e2e-data-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "e2e@example.com");
  git("config", "user.name", "e2e");
  mkdirSync(join(repo, "site"));
  writeFileSync(join(repo, "site", "old.html"), "<p>old</p>\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  writeFileSync(join(repo, "site", "index.html"), "<p>hi</p>\n");
  writeFileSync(join(repo, "site", "build"), "#!/bin/sh\n");
  chmodSync(join(repo, "site", "build"), 0o755);
  rmSync(join(repo, "site", "old.html"));

  app = await electron.launch({ args: [resolve("."), `--user-data-dir=${userData}`, repo], env: { ...process.env, MOIRE_HIDDEN: "1" } });
  page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  await app.evaluate(({ shell }) => {
    shell.openPath = async () => "";
    shell.showItemInFolder = () => {};
  });
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

test("right-clicking a file copies its paths", async () => {
  await page.getByTitle(/^site\/index\.html/).click({ button: "right" });
  await expect(menu()).toContainText("site/index.html");
  await expect(items()).toHaveText(["Copy relative path", "Copy absolute path", "Copy contents", /^Show in /, "Open in editor", "Open with default app"]);
  await expect(page.locator(".file.is-menu .name")).toHaveText("index.html");
  await shot("menu-light");
  await page.keyboard.press("Escape");
  await page.keyboard.press("t");
  await page.getByTitle(/^site\/index\.html/).click({ button: "right" });
  await shot("menu-dark");
  await page.keyboard.press("Escape");
  await page.keyboard.press("t");
  await page.getByTitle(/^site\/index\.html/).click({ button: "right" });
  await items().first().click();
  await expect(menu()).toBeHidden();
  await expect(page.locator(".toast.show")).toContainText("Copied site/index.html");
  expect(await clipboard()).toBe("site/index.html");

  await page.getByTitle(/^site\/index\.html/).click({ button: "right" });
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  expect(await clipboard()).toBe(join(repo, "site", "index.html"));
});

test("opens documents with the default app, but not programs", async () => {
  await page.getByTitle(/^site\/index\.html/).click({ button: "right" });
  await items().filter({ hasText: "Open with default app" }).click();
  await expect(page.locator(".toast.show")).toContainText("Opened index.html");

  await page.getByTitle(/^site\/build/).click({ button: "right" });
  await items().filter({ hasText: "Open with default app" }).click();
  await expect(page.locator(".toast.show")).toContainText("build is executable, so moire won't open it");
});

test("a deleted file only offers its paths, Escape closes, and the pane header has the same menu", async () => {
  await page.getByTitle(/^site\/old\.html/).click({ button: "right" });
  await expect(items().and(page.locator(":disabled"))).toHaveText(["Copy contents", /^Show in /, "Open in editor", "Open with default app"]);
  await page.keyboard.press("Escape");
  await expect(menu()).toBeHidden();

  await page.getByTitle(/^site\/index\.html/).click();
  await page.locator(".panes-head").click({ button: "right" });
  await items().first().click();
  expect(await clipboard()).toBe("site/index.html");
});

test("a folder in the tree copies its path without the trailing slash", async () => {
  await page.keyboard.press("a");
  await page.locator(".tree-dir", { hasText: "site" }).click({ button: "right" });
  await expect(items()).toHaveText(["Copy relative path", "Copy absolute path", /^Show in /, "Copy files here…"]);
  await items().first().click();
  expect(await clipboard()).toBe("site");
});
