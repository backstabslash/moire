import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { harness } from "./harness";

const { cleanRepo, initRepo, launch, launchAgain, tmp } = harness();
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

test("a theme picked in one window shows in the others", async () => {
  const [first, second] = app.windows();
  const before = await first.locator("html").getAttribute("data-theme");
  await first.keyboard.press("t");
  const after = await first.locator("html").getAttribute("data-theme");
  expect(after).not.toBe(before);
  await expect(second.locator("html")).toHaveAttribute("data-theme", after!);
});

test("a theme of the other tone, picked while following the desktop, holds in every window", async () => {
  const [first, second] = app.windows();
  for (const win of [first, second]) await win.emulateMedia({ colorScheme: "light" });
  for (const [name, id] of [
    [/Phosphor/, "p7"],
    [/Safelight/, "safelight"],
    [/Anodic/, "anodic"],
    [/Mezzotint/, "mezzotint"],
  ] as const) {
    await first.locator(".theme-btn").click();
    const follow = first.getByRole("menuitemcheckbox", { name: /Follow system/ });
    if ((await follow.getAttribute("aria-checked")) !== "true") await follow.click();
    await expect(first.locator("html")).toHaveAttribute("data-tone", "light");
    await first.getByRole("menuitemradio", { name }).click();
    await first.keyboard.press("Escape");
    for (const win of [first, second]) await expect(win.locator("html")).toHaveAttribute("data-theme", id);
    // A window applying the change in pieces used to write the desktop's theme back a moment later.
    await first.waitForTimeout(300);
    for (const win of [first, second]) expect(await win.locator("html").getAttribute("data-theme")).toBe(id);
  }
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

test("opening a repo shown in another window brings that window forward instead", async () => {
  const second = app.windows()[1];
  await second.keyboard.press("o");
  await second.getByRole("option", { name: new RegExp(basename(one)) }).click();
  await expect.poll(() => app.evaluate(() => (globalThis as { focused?: number }).focused)).toBe(2);
  await expect(second.locator(".repo")).toContainText(basename(two));
  expect(app.windows()).toHaveLength(2);
});

test("a pin shows at once in a window on a worktree of the same repo", async () => {
  const main = cleanRepo();
  writeFileSync(join(main, "a.ts"), "export const a = 2;\n");
  const worktree = join(tmp("wt"), "wt");
  execFileSync("git", ["-C", main, "worktree", "add", "-q", worktree]);
  const windowFor = async (path: string) => {
    const opened = app.waitForEvent("window");
    expect(await launchAgain(path)).toBe(0);
    const win = await opened;
    await expect(win.locator(".repo")).toContainText(basename(path));
    return win;
  };
  const [here, there] = [await windowFor(main), await windowFor(worktree)];
  await here.locator('[data-path="a.ts"]').click({ button: "right" });
  await here.getByRole("menuitem", { name: "Pin" }).click();
  await expect(there.getByRole("navigation", { name: "Pinned files" }).locator(".file .name")).toHaveText("a.ts");
  await there.locator('[data-path="a.ts"]').first().click({ button: "right" });
  await there.getByRole("menuitem", { name: "Unpin" }).click();
  await expect(here.getByRole("navigation", { name: "Pinned files" })).toHaveCount(0);
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
