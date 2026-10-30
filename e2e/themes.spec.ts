import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { harness } from "./harness";

const { git, initRepo, launch, shot, tmp } = harness();
let repo: string;
let app: ElectronApplication;
let page: Page;

const html = () => page.locator("html");

test.beforeAll(async () => {
  repo = initRepo();
  const body = Array.from({ length: 40 }, (_, i) => `export const v${i} = ${i}; // value ${i}`);
  writeFileSync(join(repo, "a.ts"), body.join("\n") + "\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  const changed = [
    ...body.slice(0, 5),
    "export const v5 = 50; // value 5",
    "export const extra = true;",
    ...body.slice(6, 30),
    "export const v30 = 300;",
    ...body.slice(31),
  ];
  writeFileSync(join(repo, "a.ts"), changed.join("\n") + "\n");

  ({ app, page } = await launch(repo, { prefs: { theme: "light" } }));
  await expect(page.locator(".hunk-head")).toHaveCount(2);
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
  await expect(page.locator(".theme-btn")).toHaveAccessibleName("Theme: Safelight");
});

test("the theme menu holds review keys, and Escape closes only the menu", async () => {
  await page.keyboard.press("/");
  await page.locator(".theme-btn").click();
  for (const key of ["s", "x", "t"]) await page.keyboard.press(key);
  expect(git("diff", "--cached")).toBe("");
  expect(git("diff")).toContain("export const extra = true;");
  await page.keyboard.press("Escape");
  await expect(page.locator(".theme-pop")).toHaveCount(0);
  await expect(page.locator(".search")).toBeVisible();
  await page.locator(".search-nav[aria-label=Close]").click();
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
  for (const [name, id] of [
    [/^Plate$/, "light"],
    [/^Plate dark/, "dark"],
    [/Engineering/, "pad"],
    [/P7/, "p7"],
    [/Safelight/, "safelight"],
    [/Cyanotype/, "cyanotype"],
  ] as const) {
    await pick(name);
    await expect(html()).toHaveAttribute("data-theme", id);
    await shot(`theme-${id}`);
  }
  await pick(/^Plate$/);
});

test("switching themes recolours code without highlighting again", async () => {
  const keyword = page.locator(".cell.add span", { hasText: "export" }).first();
  await expect(keyword).toHaveAttribute("style", /var\(--tok-kw\)/);
  const colour = await keyword.evaluate((el) => getComputedStyle(el).color);
  await page.keyboard.press("t");
  await expect(keyword).not.toHaveCSS("color", colour);
  await expect(keyword).toHaveAttribute("style", /var\(--tok-kw\)/);
  await page.keyboard.press("t");
  await expect(keyword).toHaveCSS("color", colour);
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

test("code font and size apply to the diff and survive a reload", async () => {
  await page.locator(".theme-btn").click();
  await page.getByLabel("Larger code").click();
  await page.getByLabel("Code font").fill("Liberation Mono");
  await shot("code-font");
  await page.keyboard.press("Escape");
  const cell = page.locator(".diff").first();
  await expect.poll(() => cell.evaluate((el) => getComputedStyle(el).fontSize)).toBe("16px");
  await expect.poll(() => cell.evaluate((el) => getComputedStyle(el).fontFamily)).toContain("Liberation Mono");
  await page.reload();
  await expect(page.locator(".diff").first()).toBeVisible();
  await expect
    .poll(() =>
      page
        .locator(".diff")
        .first()
        .evaluate((el) => getComputedStyle(el).fontSize),
    )
    .toBe("16px");
});

test("the theme follows the desktop until you pick the other tone", async () => {
  ({ page } = await launch(repo, { data: tmp("data") }));
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator(".hunk-head").first()).toBeVisible();
  const follow = page.getByRole("menuitemcheckbox", { name: /Follow system/ });
  await expect(html()).toHaveAttribute("data-theme", "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(html()).toHaveAttribute("data-theme", "dark");

  await page.locator(".theme-btn").click();
  await expect(follow).toHaveAttribute("aria-checked", "true");
  await page.getByRole("menuitemradio", { name: /Safelight/ }).click();
  await expect(follow).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(html()).toHaveAttribute("data-theme", "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(html()).toHaveAttribute("data-theme", "safelight");

  await page.keyboard.press("t");
  await expect(html()).toHaveAttribute("data-theme", "light");
  await page.emulateMedia({ colorScheme: "light" });
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(html()).toHaveAttribute("data-theme", "light");
  await page.locator(".theme-btn").click();
  await expect(follow).toHaveAttribute("aria-checked", "false");
  await page.keyboard.press("Escape");
});
