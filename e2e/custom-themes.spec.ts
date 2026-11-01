import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { harness } from "./harness";

const { commitAll, html, initRepo, launch, pick, recordOpens, shot, tmp, variable } = harness();
let repo: string;
let data: string;
let app: ElectronApplication;
let page: Page;

const file = () => join(data, "themes.json");
const save = (...themes: unknown[]) => writeFileSync(file(), JSON.stringify({ themes }));
const mine = { name: "Harbour", extends: "anodic", colors: { plate: "#1c2326", a: "#e0a050", b: "#70b8d0" } };
const theme = (name: RegExp) => page.getByRole("menuitemradio", { name });

const open = async () => {
  ({ app, page } = await launch(repo, { data, prefs: { theme: "light" } }));
  await expect(page.locator(".hunk-head")).toHaveCount(1);
};

const toggleCvd = async () => {
  await page.locator(".theme-btn").click();
  await page.getByRole("menuitemcheckbox", { name: /Colour-blind/ }).click();
  await page.keyboard.press("Escape");
};

const builtIn = (id: string, name: string, cvd = "off") =>
  page.evaluate(
    ([id, name, cvd]) => {
      const probe = Object.assign(document.createElement("span"), { hidden: true });
      probe.dataset.theme = id;
      probe.dataset.cvd = cvd;
      document.body.append(probe);
      return getComputedStyle(probe).getPropertyValue(name).trim();
    },
    [id, name, cvd],
  );

const painted = (hex: string) =>
  page.locator(".minimap canvas").evaluate((canvas: HTMLCanvasElement, hex) => {
    const { data } = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height);
    const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
    for (let i = 0; i < data.length; i += 4) if (data[i] === r && data[i + 1] === g && data[i + 2] === b) return true;
    return false;
  }, hex);

test.beforeAll(async () => {
  repo = initRepo();
  writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
  commitAll("init");
  writeFileSync(join(repo, "a.ts"), "export const a = 2;\n");
  data = tmp("data");
  await open();
});

test("the menu creates the file with a starter, and opens it", async () => {
  const opened = await recordOpens();
  await page.locator(".theme-btn").click();
  await page.getByRole("menuitem", { name: /Custom themes/ }).click();
  await expect(page.locator(".theme-pop")).toHaveCount(0);
  await expect.poll(opened).toEqual([file()]);
  const written = JSON.parse(readFileSync(file(), "utf8")) as { themes: unknown[]; "//example": unknown };
  expect(written.themes).toEqual([]);
  expect(written["//example"]).toBeTruthy();
});

test("saving the file applies at once and repaints the minimap, and a removed theme leaves the one kept for the other tone", async () => {
  save(mine);
  await pick(/Gypsum/);
  await pick(/Harbour/);
  await expect(html()).toHaveAttribute("data-theme", "custom-harbour");
  save({ ...mine, colors: { ...mine.colors, a: "#ff8800" } });
  await expect.poll(() => variable("--a")).toBe("#ff8800");
  await expect.poll(() => painted("#ff8800")).toBe(true);

  save();
  await expect(html()).not.toHaveAttribute("data-theme", "custom-harbour");
  await page.locator(".theme-btn").click();
  await expect(theme(/Harbour/)).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.keyboard.press("t");
  await expect(html()).toHaveAttribute("data-theme", "gypsum");
});

test("a broken save says so and leaves every theme working, and a bad entry only hides its theme until it's fixed", async () => {
  save(mine);
  await pick(/Harbour/);
  writeFileSync(file(), "{ nope");
  await expect(page.locator(".toast")).toContainText("themes.json");
  await expect(page.locator(".toast")).toContainText("valid JSON");
  await expect(html()).toHaveAttribute("data-theme", "custom-harbour");
  await pick(/Gypsum/);
  await expect(html()).toHaveAttribute("data-theme", "gypsum");
  await pick(/Harbour/);
  await expect(html()).toHaveAttribute("data-theme", "custom-harbour");

  rmSync(file());
  mkdirSync(file());
  await expect(page.locator(".toast")).toContainText("can't be read, so the last themes stay");
  await expect(html()).toHaveAttribute("data-theme", "custom-harbour");
  rmSync(file(), { recursive: true });
  save(mine);

  save({ ...mine, extends: "nope" });
  await expect(html()).not.toHaveAttribute("data-theme", "custom-harbour");
  save(mine);
  await expect(html()).toHaveAttribute("data-theme", "custom-harbour");
});

test("a theme that's hard to read loads with a warning", async () => {
  save({ name: "Murk", extends: "dark", colors: { "tok-str": "#303030" } });
  await expect(page.locator(".toast")).toContainText("Murk may be hard to read");
  await pick(/Murk/);
  await expect(html()).toHaveAttribute("data-theme", "custom-murk");
  await page.locator(".theme-btn").click();
  await expect(theme(/Murk/).locator(".theme-warn")).toBeVisible();
  await expect(theme(/Murk/)).toHaveAttribute("data-tip", /strings on the background \d/);
  await page.keyboard.press("Escape");
});

test("themes in the file join the menu, set what they name plus what follows, take their tone's colour-blind plates, and survive a restart", async () => {
  const paper = { name: "Paper", extends: "anodic", colors: { plate: "#f5f5f0", ink: "#202020", a: "#b03020", b: "#2060a0" } };
  save(mine, paper);
  await page.locator(".theme-btn").click();
  await expect(theme(/Paper/)).toBeVisible();
  await shot("custom-theme-menu");
  await theme(/Harbour/).click();
  await page.keyboard.press("Escape");

  await expect(html()).toHaveAttribute("data-theme", "custom-harbour");
  await expect(html()).toHaveAttribute("data-tone", "dark");
  expect(await variable("--plate")).toBe("#1c2326");
  expect(await variable("--a")).toBe("#e0a050");
  expect(await variable("--tok-str")).toBe(await builtIn("anodic", "--tok-str"));
  await expect(page.locator(".theme-btn")).toHaveAccessibleName("Theme: Harbour");
  await shot("custom-theme");
  await page.keyboard.press("t");
  await expect(html()).toHaveAttribute("data-tone", "light");
  await page.keyboard.press("t");
  await expect(html()).toHaveAttribute("data-theme", "custom-harbour");

  await toggleCvd();
  await expect(html()).toHaveAttribute("data-cvd", "on");
  expect(await variable("--a")).not.toBe("#e0a050");
  expect(await variable("--plate")).toBe("#1c2326");

  await pick(/Paper/);
  await expect(html()).toHaveAttribute("data-theme", "custom-paper");
  expect(await variable("--a-ink")).toBe(await builtIn("light", "--a-ink", "on"));
  await toggleCvd();
  await expect(html()).toHaveAttribute("data-cvd", "off");
  expect(await variable("--a")).toBe("#b03020");
  expect(await variable("--tok-str")).toBe(await builtIn("light", "--tok-str"));

  await pick(/Harbour/);
  await expect(html()).toHaveAttribute("data-theme", "custom-harbour");
  await app.close();
  ({ app, page } = await launch(repo, { data }));
  await expect(page.locator(".hunk-head")).toHaveCount(1);
  await expect(html()).toHaveAttribute("data-theme", "custom-harbour");
  expect(await variable("--plate")).toBe("#1c2326");
});

test("following the desktop, a typo that flips a theme's tone stands in the built-in, and fixing it brings both choices back", async () => {
  const paper = { name: "Paper", extends: "anodic", colors: { plate: "#f5f5f0", ink: "#202020" } };
  data = tmp("data");
  save(paper);
  ({ app, page } = await launch(repo, { data, prefs: { theme: "dark", "theme-follow": "on" } }));
  await page.emulateMedia({ colorScheme: "dark" });
  await pick(/Phosphor/);
  await page.emulateMedia({ colorScheme: "light" });
  await pick(/Paper/);
  await expect(html()).toHaveAttribute("data-theme", "custom-paper");

  save({ ...paper, colors: { ...paper.colors, plate: "#f5f5f" } });
  await expect(html()).toHaveAttribute("data-theme", "light");
  save(paper);
  await expect(html()).toHaveAttribute("data-theme", "custom-paper");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(html()).toHaveAttribute("data-theme", "p7");
});

test("saving the same mistake twice warns twice, and the menu keeps saying so", async () => {
  data = tmp("data");
  save({ ...mine, colors: { a: "#fff" } });
  await open();
  await expect(page.locator(".toast.show")).toContainText("a should be a colour");
  await page.keyboard.press(".");
  await expect(page.locator(".toast.show")).toContainText("No agent notes");
  save({ ...mine, colors: { a: "#ffff" } });
  await expect(page.locator(".toast.show")).toContainText("a should be a colour");
  await page.locator(".theme-btn").click();
  await expect(page.locator(".theme-problems")).toContainText("a should be a colour");
});
