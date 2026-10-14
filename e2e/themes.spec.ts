import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
const html = () => page.locator("html");

test.beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "moire-e2e-repo-"));
  userData = mkdtempSync(join(tmpdir(), "moire-e2e-data-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "e2e@example.com");
  git("config", "user.name", "e2e");
  const body = Array.from({ length: 40 }, (_, i) => `export const v${i} = ${i}; // value ${i}`);
  writeFileSync(join(repo, "a.ts"), body.join("\n") + "\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  // a two-line change with one line added, so the plates differ in length, then a second hunk further down
  const changed = [...body.slice(0, 5), "export const v5 = 50; // value 5", "export const extra = true;", ...body.slice(6, 30), "export const v30 = 300;", ...body.slice(31)];
  writeFileSync(join(repo, "a.ts"), changed.join("\n") + "\n");

  app = await electron.launch({ args: [resolve("."), `--user-data-dir=${userData}`, repo], env: { ...process.env, MOIRE_HIDDEN: "1", MOIRE_PREFS: '{"theme":"light"}' } });
  page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  await expect(page.locator(".hunk-head")).toHaveCount(2);
});

test.afterAll(async () => {
  await app?.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(userData, { recursive: true, force: true });
});

test.afterEach(() => {
  expect(errors).toEqual([]);
});

test("the theme menu switches themes and colour-blind plates", async () => {
  const plateA = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--a").trim());
  await page.locator(".theme-btn").click();
  await expect(page.getByRole("menuitemradio")).toHaveCount(6);
  await shot("theme-menu");
  await page.getByRole("menuitemradio", { name: /Safelight/ }).click();
  await expect(html()).toHaveAttribute("data-theme", "safelight");
  await expect(html()).toHaveAttribute("data-tone", "dark");
  const warm = await plateA();
  await page.getByRole("menuitemcheckbox", { name: /Colour-blind/ }).click();
  await expect(html()).toHaveAttribute("data-cvd", "on");
  expect(await plateA()).not.toBe(warm);
  await page.getByRole("menuitemcheckbox", { name: /Colour-blind/ }).click();
  await page.keyboard.press("Escape");
  await expect(page.locator(".theme-pop")).toHaveCount(0);
  await expect(page.locator(".theme-btn")).toContainText("Safelight");
});

test("t swaps between the last light and the last dark theme", async () => {
  const pick = async (name: RegExp) => {
    await page.locator(".theme-btn").click();
    await page.getByRole("menuitemradio", { name }).click();
    await page.keyboard.press("Escape");
  };
  await pick(/Engineering pad/);
  await page.keyboard.press("t");
  await expect(html()).toHaveAttribute("data-theme", "safelight");
  await page.keyboard.press("t");
  await expect(html()).toHaveAttribute("data-theme", "pad");
  for (const [name, id] of [[/^Plate Glass/, "light"], [/^Plate dark/, "dark"], [/Engineering/, "pad"], [/P7/, "p7"], [/Safelight/, "safelight"], [/Cyanotype/, "cyanotype"]] as const) {
    await pick(name);
    await expect(html()).toHaveAttribute("data-theme", id);
    await shot(`theme-${id}`);
  }
  await pick(/^Plate Glass/);
});

test("holding b shows plate A in place, and letting go shows plate B", async () => {
  const next = page.locator(".hunk-head").nth(1);
  const before = (await next.boundingBox())!.y;
  await page.keyboard.down("b");
  await expect(page.locator(".main")).toHaveAttribute("data-plate", "a");
  await expect(page.locator(".row.plate .pa .cell.del")).toHaveCount(1);
  await expect(page.locator(".stamp")).toContainText("Plate A");
  const held = (await next.boundingBox())!.y;
  await page.keyboard.up("b");
  await expect(page.locator(".main")).toHaveAttribute("data-plate", "b");
  await shot("blink-b");
  // both plates share each row, so nothing below the hunk moves when they flip
  expect((await next.boundingBox())!.y).toBe(held);
  expect(held).toBeGreaterThanOrEqual(before);
  await page.keyboard.press("Escape");
  await expect(page.locator(".main")).not.toHaveAttribute("data-plate");
  await expect(page.locator(".row.plate")).toHaveCount(0);
});

test("the Blink button flips the plates on its own until stopped", async () => {
  await page.keyboard.press("v");
  await page.locator(".hunk-head").first().getByRole("button", { name: "Blink" }).click();
  await expect(page.locator(".row.plate").first()).toBeVisible();
  await expect(page.locator(".main")).toHaveAttribute("data-plate", "a", { timeout: 2000 });
  await expect(page.locator(".main")).toHaveAttribute("data-plate", "b", { timeout: 2000 });
  await page.locator(".hunk-head").first().getByRole("button", { name: "Stop blink" }).click();
  await expect(page.locator(".row.plate")).toHaveCount(0);
  // a clicked button hands focus back, so shortcuts don't press it again
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("BODY");
  await page.keyboard.press("Shift+B");
  await expect(page.locator(".row.plate").first()).toBeVisible();
  await page.keyboard.press("Shift+B");
  await expect(page.locator(".row.plate")).toHaveCount(0);
  await expect(page.locator(".row.uni").first()).toBeVisible();
  await page.keyboard.press("v");
});

test("Ctrl+= zooms in, shows the level, and Ctrl+0 resets it", async () => {
  const factor = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor());
  // Playwright's keys go straight to the page, so send them where the main process sees them
  const press = (keyCode: string) =>
    app.evaluate(({ BrowserWindow }, keyCode) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      contents.sendInputEvent({ type: "keyDown", keyCode, modifiers: [process.platform === "darwin" ? "meta" : "control"] });
      contents.sendInputEvent({ type: "keyUp", keyCode, modifiers: [process.platform === "darwin" ? "meta" : "control"] });
    }, keyCode);
  await press("=");
  await expect.poll(factor).toBeCloseTo(1.1);
  await expect(page.locator(".toast")).toContainText("Zoom 110%");
  await expect(page.locator(".status .zoom")).toHaveText("110%");
  await press("-");
  await press("-");
  await expect.poll(factor).toBeCloseTo(0.9);
  await page.locator(".status .zoom").click();
  await expect.poll(factor).toBe(1);
  await expect(page.locator(".status .zoom")).toHaveCount(0);
});
