import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { harness } from "./harness";

const { initRepo, launch, launchAgain, tmp } = harness();
let one: string;
let two: string;
let plain: string;
let app: ElectronApplication;
let page: Page;

function makeRepo() {
  const dir = initRepo();
  writeFileSync(join(dir, "a.txt"), "a\n");
  return dir;
}

test.beforeAll(async () => {
  one = makeRepo();
  two = makeRepo();
  plain = tmp("plain");
  ({ app, page } = await launch(one));
  await expect(page.locator(".repo")).toContainText(basename(one));
});

test("the window is titled after the repo", async () => {
  await expect(page).toHaveTitle(`${basename(one)} - Moire`);
});

test("a second launch opens its repo in a new window of the running app", async () => {
  const opened = app.waitForEvent("window");
  expect(await launchAgain(two)).toBe(0);
  await expect((await opened).locator(".repo")).toContainText(basename(two));
  expect(app.windows()).toHaveLength(2);
});

test("launching an open repo again reuses its window", async () => {
  await app.evaluate(({ BrowserWindow }) => {
    const seen = globalThis as { focused?: number };
    seen.focused = 0;
    for (const win of BrowserWindow.getAllWindows()) {
      const focus = win.focus.bind(win);
      win.focus = () => {
        seen.focused!++;
        focus();
      };
    }
  });
  expect(await launchAgain(one)).toBe(0);
  await expect.poll(() => app.evaluate(() => (globalThis as { focused?: number }).focused)).toBe(1);
  expect(app.windows()).toHaveLength(2);
});

test("a path that isn't a repo opens as a folder instead of opening another repo", async () => {
  const opened = app.waitForEvent("window");
  expect(await launchAgain(plain)).toBe(0);
  const win = await opened;
  await expect(win.locator(".repo")).toContainText(basename(plain));
  await expect(win.locator(".empty-state")).toContainText(`${basename(plain)} isn't a git repository.`);
});

test("a launch without a repo, like a panel's Open New Window, opens a window with the picker", async () => {
  const opened = app.waitForEvent("window");
  expect(await launchAgain()).toBe(0);
  await expect((await opened).getByRole("heading", { name: "Open a repository." })).toBeVisible();
});

test("the open file and the sidebar width come back after a restart", async () => {
  const repo = makeRepo();
  const data = tmp("data");
  writeFileSync(join(repo, "b.txt"), "b\n");
  ({ app, page } = await launch(repo, { data }));
  await page.locator(".file", { hasText: "b.txt" }).click();
  await expect(page.locator(".file.is-active .name")).toHaveText("b.txt");
  const before = (await page.locator(".sidebar").boundingBox())!.width;
  const edge = (await page.locator(".side-resize").boundingBox())!;
  await page.mouse.move(edge.x + edge.width / 2, edge.y + 200);
  await page.mouse.down();
  await page.mouse.move(edge.x + edge.width / 2 + 100, edge.y + 200, { steps: 4 });
  await page.mouse.up();
  const width = (await page.locator(".sidebar").boundingBox())!.width;
  expect(width).toBeGreaterThan(before);

  await app.close();
  ({ app, page } = await launch(repo, { data }));
  await expect(page.locator(".file.is-active .name")).toHaveText("b.txt");
  expect((await page.locator(".sidebar").boundingBox())!.width).toBe(width);
});
