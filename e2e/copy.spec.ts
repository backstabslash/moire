import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, type ElectronApplication, expect, type Page, test } from "@playwright/test";

let repo: string;
let userData: string;
let app: ElectronApplication;
let page: Page;
const errors: string[] = [];

const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
const shot = (name: string) => process.env.MOIRE_SHOTS && page.screenshot({ path: join(process.env.MOIRE_SHOTS, `${name}.png`) });
const clipboard = () => app.evaluate(({ clipboard }) => clipboard.readText());
const clearClipboard = () => app.evaluate(({ clipboard }) => clipboard.writeText(""));
const mod = process.platform === "darwin" ? "Meta" : "Control";
const body = Array.from({ length: 30 }, (_, i) => `export const v${i + 1} = ${i + 1};`);
const edited = body.map((l, i) => (i === 4 || i === 15 ? l.replace("=", "= 10 *") : l));
const long = Array.from({ length: 300 }, (_, i) => `export const w${i + 1} = ${i + 1};`).join("\n") + "\n";
const ln = (side: "a" | "b", n: number) => page.locator(`.ln.${side}[data-line]`, { hasText: new RegExp(`^${n}$`) });
const cell = (side: "a" | "b", n: number) => page.locator(".row.split", { has: ln(side, n) }).locator(`.cell.${side}`);
const picked = () => page.locator(".ln.b.sel");

test.beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "moire-e2e-repo-"));
  userData = mkdtempSync(join(tmpdir(), "moire-e2e-data-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "e2e@example.com");
  git("config", "user.name", "e2e");
  writeFileSync(join(repo, "a.ts"), body.join("\n") + "\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  writeFileSync(join(repo, "a.ts"), edited.join("\n") + "\n");
  writeFileSync(join(repo, "long.ts"), long);

  app = await electron.launch({
    args: [resolve("."), `--user-data-dir=${userData}`, repo],
    env: { ...process.env, MOIRE_HIDDEN: "1", MOIRE_PREFS: '{"theme":"light"}' },
  });
  page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  await expect(page.locator(".file")).toHaveCount(2);
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

test("a text drag across two hunks copies one side, without header text or duplicates", async () => {
  await clearClipboard();
  const from = (await cell("b", 4).boundingBox())!;
  const to = (await cell("b", 14).boundingBox())!;
  await page.mouse.move(from.x + 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
  await page.mouse.move(to.x + to.width - 2, to.y + to.height / 2);
  await page.mouse.up();
  await page.keyboard.press(`${mod}+c`);
  await expect.poll(clipboard).toBe([4, 5, 6, 7, 8, 13, 14].map((n) => edited[n - 1]).join("\n"));

  await page.evaluate(() => {
    const textOf = (n: number) => {
      const row = [...document.querySelectorAll(".row.split")].find((r) => r.querySelector(".ln.b")?.textContent === String(n));
      return document.createTreeWalker(row!.querySelector(".cell.b .text")!, NodeFilter.SHOW_TEXT).nextNode()!;
    };
    getSelection()!.setBaseAndExtent(textOf(4), 2, textOf(14), 3);
  });
  await page.keyboard.press(`${mod}+c`);
  await expect.poll(clipboard).toBe(["port const v4 = 4;", ...[5, 6, 7, 8, 13].map((n) => edited[n - 1]), "exp"].join("\n"));
});

test("a click replaces the selection, Mod+click toggles a line and shift-click adds a range", async () => {
  await ln("b", 3).click();
  await expect(picked()).toHaveText(["3"]);
  await expect(page.locator(".ln.a.sel")).toHaveCount(0);
  await ln("b", 5).click();
  await expect(picked()).toHaveText(["5"]);
  await ln("b", 7).click({ modifiers: [mod] });
  await expect(picked()).toHaveText(["5", "7"]);
  await ln("b", 14).click({ modifiers: ["Shift"] });
  await expect(picked()).toHaveText(["5", "7", "8", "13", "14"]);
  await ln("b", 5).click({ modifiers: [mod] });
  await expect(picked()).toHaveText(["7", "8", "13", "14"]);
  await page.keyboard.press(`${mod}+c`);
  await expect(page.locator(".toast.show")).toHaveText("Copied 4 lines");
  expect(await clipboard()).toBe([7, 8, 13, 14].map((n) => `${edited[n - 1]}\n`).join(""));
  await page.keyboard.press("Escape");
});

test("a hunk's range selects its changed lines, and the pane head offers to copy them", async () => {
  await page.locator(".hunk-head .hh-range").first().click();
  await expect(picked()).toHaveText(["5"]);
  await expect(page.locator(".pane-h").nth(1).locator(".pane-copy")).toHaveText("1 lineCopy linesctrl c");
  await expect(page.locator(".pane-h").first().locator(".pane-copy")).toHaveText("Copy old version");
  await ln("b", 4).click();
  await ln("b", 7).click({ modifiers: ["Shift"] });
  await expect(page.locator(".pane-h").nth(1).locator(".sel-count")).toHaveText("4 lines");
  await shot("pane-head-selection-light");
  await page.keyboard.press("t");
  await shot("pane-head-selection-dark");
  await page.keyboard.press("t");
  await page
    .locator(".pane-copy")
    .getByRole("button", { name: /^Copy lines/ })
    .click();
  expect(await clipboard()).toBe([4, 5, 6, 7].map((n) => `${edited[n - 1]}\n`).join(""));
  await page.keyboard.press("Escape");
});

test("Mod+a then Mod+c copies the side last clicked, folded lines included", async () => {
  await page.keyboard.press(`${mod}+a`);
  await expect(page.locator(".pane-h").nth(1).locator(".sel-count")).toHaveText("30 lines");
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("");
  await page.keyboard.press(`${mod}+c`);
  await expect(page.locator(".toast.show")).toHaveText("Copied a.ts, 30 lines");
  expect(await clipboard()).toBe(readFileSync(join(repo, "a.ts"), "utf8"));

  await cell("a", 3).click();
  await page.keyboard.press(`${mod}+a`);
  await expect(page.locator(".pane-h").first().locator(".sel-count")).toHaveText("30 lines");
  await expect(page.locator(".ln.b.sel")).toHaveCount(0);
  await page.keyboard.press(`${mod}+c`);
  expect(await clipboard()).toBe(git("show", ":a.ts"));
  await page.keyboard.press("Escape");
  await expect(page.locator(".pane-copy .sel-count")).toHaveCount(0);
});

test("Copy file and Copy contents copy the whole file", async () => {
  await clearClipboard();
  await page.getByRole("button", { name: "Copy file" }).click();
  await expect(page.locator(".toast.show")).toHaveText("Copied a.ts, 30 lines");
  expect(await clipboard()).toBe(readFileSync(join(repo, "a.ts"), "utf8"));
  await clearClipboard();
  await page.locator(".file", { hasText: "long.ts" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Copy contents" }).click();
  await expect(page.locator(".toast.show")).toHaveText("Copied long.ts, 300 lines");
  expect(await clipboard()).toBe(long);
});

test("a gutter drag to the bottom edge scrolls the diff and extends the selection", async () => {
  await page.locator(".file", { hasText: "long.ts" }).click();
  await expect(page.locator(".pane-h b").last()).toHaveText("long.ts");
  const scroller = page.locator(".diff-scroller");
  const box = (await scroller.boundingBox())!;
  const start = (await ln("b", 2).boundingBox())!;
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(start.x + start.width / 2, box.y + box.height - 4, { steps: 10 });
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(1000);
  await page.mouse.up();
  const top = await scroller.evaluate((el) => el.scrollTop);
  const last = Number(await picked().last().textContent());
  expect(last).toBeGreaterThan(60);
  await page.waitForTimeout(100);
  expect(await scroller.evaluate((el) => el.scrollTop)).toBe(top);
  await page.keyboard.press(`${mod}+c`);
  expect((await clipboard()).split("\n").slice(0, 2)).toEqual(["export const w2 = 2;", "export const w3 = 3;"]);
  expect(await clipboard()).toContain(`export const w${last} = ${last};\n`);
});

test("staging a hunk picked from its header stages the whole hunk, not just its new lines", async () => {
  await page.locator(".file", { hasText: "a.ts" }).click();
  await page.locator(".hunk-head .hh-range").first().click();
  await expect(picked()).toHaveText(["5"]);
  await expect(page.locator(".hunk-head.has-sel .hh-stage")).toHaveText(/^Stage 2 lines/);
  await page.keyboard.press("s");
  await expect.poll(() => git("show", ":a.ts")).toContain(`${edited[3]}\n${edited[4]}\n${edited[5]}\n`);
  expect(git("show", ":a.ts")).not.toContain(`${body[4]}\n`);
  git("reset", "-q");
});
