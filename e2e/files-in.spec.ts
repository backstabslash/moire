import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, type ElectronApplication, expect, type Page, test } from "@playwright/test";

let repo: string;
let outside: string;
let userData: string;
let app: ElectronApplication;
let page: Page;
const errors: string[] = [];

const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args]);
const shot = (name: string) => process.env.MOIRE_SHOTS && page.screenshot({ path: join(process.env.MOIRE_SHOTS, `${name}.png`) });
const nav = () => page.getByRole("navigation", { name: "All files" });
const dir = (path: string) => page.locator(`.tree-dir[data-dir="${path}"]`);
const toast = () => page.locator(".toast.show");
const foot = () => page.locator(".drop-foot");

// Chromium keeps sending dragover while a drag is over the window, so the page does the same until told to drop or leave.
const dragTo = async (selector: string) => {
  await page.locator(selector).first().waitFor();
  await page.evaluate((sel) => {
    const w = window as unknown as { dragTimer?: number; dragAt?: string };
    const fire = (type: string, at: string) => {
      const data = new DataTransfer();
      data.items.add(new File(["<svg/>"], "flag.svg", { type: "image/svg+xml" }));
      document.querySelector(at)!.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data }));
    };
    if (!w.dragTimer) {
      fire("dragenter", sel);
      w.dragTimer = window.setInterval(() => fire("dragover", w.dragAt!), 100);
    }
    w.dragAt = sel;
    fire("dragover", sel);
  }, selector);
};
const endDrag = (how: "drop" | "dragleave") =>
  page.evaluate((type) => {
    const w = window as unknown as { dragTimer?: number; dragAt?: string };
    clearInterval(w.dragTimer);
    w.dragTimer = undefined;
    const data = new DataTransfer();
    data.items.add(new File(["<svg/>"], "flag.svg", { type: "image/svg+xml" }));
    document.querySelector(w.dragAt!)!.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data }));
  }, how);
const background = (selector: string) => page.locator(selector).evaluate((el) => getComputedStyle(el).backgroundColor);
const bLine = () =>
  page.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.background = "var(--b-line)";
    document.body.append(probe);
    const color = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return color;
  });
const stubClipboard = (paths: string[]) =>
  app.evaluate(({ ipcMain }, list) => {
    ipcMain.removeHandler("files:clipboard");
    ipcMain.handle("files:clipboard", () => list);
  }, paths);

test.beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "moire-e2e-repo-"));
  outside = mkdtempSync(join(tmpdir(), "moire-e2e-downloads-"));
  userData = mkdtempSync(join(tmpdir(), "moire-e2e-data-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "e2e@example.com");
  git("config", "user.name", "e2e");
  for (const d of ["src/lib/money", "docs", "dist"]) mkdirSync(join(repo, d), { recursive: true });
  writeFileSync(join(repo, ".gitignore"), "dist/\n");
  writeFileSync(join(repo, "src", "app.ts"), "export const app = 1;\n");
  writeFileSync(join(repo, "src", "lib", "money", "format.ts"), "export function format(cents: number) {\n  return `$${cents / 100}`;\n}\n");
  writeFileSync(join(repo, "src", "lib", "money", "round.ts"), "export const round = Math.round;\n");
  writeFileSync(join(repo, "docs", "guide.md"), "# Guide\n");
  writeFileSync(join(repo, "dist", "app.js"), "built\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  writeFileSync(join(repo, "src", "app.ts"), "export const app = 2;\n");

  writeFileSync(join(outside, "format.ts"), "export function format(cents: number, code: string) {\n  return (cents / 100).toFixed(2) + ' ' + code;\n}\n");
  writeFileSync(join(outside, "rates.json"), '{ "EUR": 0.92 }\n');

  app = await electron.launch({ args: [resolve("."), `--user-data-dir=${userData}`, repo], env: { ...process.env, MOIRE_HIDDEN: "1" } });
  page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  await expect(page.locator(".file")).toHaveCount(1);
});

test.afterAll(async () => {
  await app?.close();
  for (const d of [repo, outside, userData]) rmSync(d, { recursive: true, force: true });
});

test.afterEach(() => {
  expect(errors).toEqual([]);
});

test("a file dragged over the sidebar opens All files and tints the target folder", async () => {
  await dragTo(".sidebar .file");
  await expect(nav()).toBeVisible();
  await dragTo('.tree-dir[data-dir="src/"]');
  await expect(foot()).toHaveText(/Drop to copy 1 item into\s*src\/\s*The originals stay where they are\./);
  const tint = await bLine();
  expect(await background('.tree-dir[data-dir="src/"]')).toBe(tint);
  expect(await background('.file[data-path="src/app.ts"]')).toBe(tint);
  expect(await background('.tree-dir[data-dir="docs/"]')).not.toBe(tint);

  await dragTo('.tree-seg[data-dir="src/lib/"]');
  await expect(dir("src/lib/money/")).toHaveAttribute("aria-expanded", "true");
  await expect(foot()).toContainText("src/lib/");
  await expect(foot()).not.toContainText("money");
  await shot("files-in-drag-light");

  await dragTo('.tree-dir[data-dir="dist/"]');
  await expect(foot()).toContainText("Git ignores this folder, so the copies won't show in Changed.");
  expect(await background('.tree-dir[data-dir="dist/"]')).not.toBe(tint);

  await dragTo(".sidebar .files");
  await dragTo(".diff-scroller");
  await expect(page.locator(".drop-slot")).toHaveText([/Next to the open file\s*src\//, /Repository root\s*\//]);
  await dragTo('.drop-slot[data-slot=""]');
  await expect(page.locator(".drop-slot.is-hot")).toContainText("Repository root");
  await expect(foot()).toContainText("the repository root");
  await shot("files-in-slots-light");

  await dragTo('.tree-dir[data-dir="docs/"]');
  await page.mouse.move(40, 300);
  await page.mouse.move(60, 320);
  await expect(foot()).toContainText("docs/");
  await endDrag("drop");
  await expect(toast()).toHaveText("Can't read this file. Try Copy files here… or paste it.");
  await expect(page.getByRole("navigation", { name: "Changed files" })).toBeVisible();
  await expect(foot()).toHaveCount(0);

  await expect(toast()).toHaveCount(0, { timeout: 8000 });
  await page.keyboard.press("t");
  await dragTo(".sidebar .file");
  await expect(dir("src/lib/money/")).toBeVisible();
  await dragTo('.tree-seg[data-dir="src/lib/"]');
  await expect(foot()).toContainText("src/lib/");
  await shot("files-in-drag-dark");
  await endDrag("dragleave");
  await expect(foot()).toHaveCount(0);
  await page.keyboard.press("t");
});

test("pasted files clash, the clash is reviewed as a diff, replaced and undone", async () => {
  await stubClipboard([join(outside, "format.ts"), join(outside, "rates.json")]);
  await expect(toast()).toHaveCount(0, { timeout: 8000 });
  await page.keyboard.press("a");
  await page.keyboard.press("p");
  await page.keyboard.type("money/round");
  await page.keyboard.press("Enter");
  await page.locator(".file-filter").press("Escape");
  await expect(nav().locator(".file.is-active")).toHaveAttribute("data-path", "src/lib/money/round.ts");
  await page.keyboard.press("ControlOrMeta+v");
  const bar = page.locator(".clash-bar");
  await expect(bar).toContainText("format.ts already exists in src/lib/money/");
  await expect(bar).toContainText("1 of 1");
  await expect(page.locator(".panes-head .tag-a")).toHaveAttribute("data-tip", "In the repository");
  await expect(page.locator(".cell.add").first()).toContainText("code: string");
  await expect(page.locator('.file[data-path="src/lib/money/rates.json"] .name')).toHaveCSS("font-style", "italic");
  await expect(foot()).toContainText("1 name clash to decide in the diff.");
  await shot("files-in-clash-light");
  await page.evaluate(() => Object.assign(document.documentElement.dataset, { theme: "dark", tone: "dark" }));
  await shot("files-in-clash-dark");
  await page.evaluate(() => Object.assign(document.documentElement.dataset, { theme: "light", tone: "light" }));

  await page.keyboard.press("Enter");
  await expect(toast()).toContainText("Copied 2 files into src/lib/money/. Replaced format.ts; undo restores it.");
  await expect(bar).toHaveCount(0);
  expect(readFileSync(join(repo, "src/lib/money/format.ts"), "utf8")).toContain("code: string");
  expect(readFileSync(join(repo, "src/lib/money/rates.json"), "utf8")).toBe('{ "EUR": 0.92 }\n');
  expect(readFileSync(join(outside, "format.ts"), "utf8")).toContain("code: string");

  await toast().getByRole("button", { name: /Undo/ }).click();
  await expect(toast()).toHaveText("Undid: Copied 2 files into src/lib/money/");
  expect(readFileSync(join(repo, "src/lib/money/format.ts"), "utf8")).toContain("return `$");
  expect(existsSync(join(repo, "src/lib/money/rates.json"))).toBe(false);
  expect(git("status", "--porcelain").toString()).toBe(" M src/app.ts\n");
});

test("Escape cancels a clash, a focused folder takes the paste, and other views refuse it", async () => {
  await stubClipboard([join(outside, "format.ts")]);
  await page.keyboard.press("ControlOrMeta+v");
  await expect(page.locator(".clash-bar")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(toast()).toHaveText("Nothing was copied.");
  await expect(page.locator(".clash-bar")).toHaveCount(0);

  await dir("docs/").focus();
  await page.keyboard.press("ControlOrMeta+v");
  await expect(toast()).toContainText("Copied 1 file into docs/.");
  expect(existsSync(join(repo, "docs/format.ts"))).toBe(true);
  await page.keyboard.press("u");
  await expect(toast()).toHaveText("Undid: Copied 1 file into docs/");

  await page.keyboard.press("2");
  await expect(page.locator(".picker-btn")).toHaveText("Staged");
  await page.keyboard.press("ControlOrMeta+v");
  await expect(toast()).toHaveText("Switch to Unstaged to copy files in");
  await page.keyboard.press("1");

  await stubClipboard([]);
  await page.locator(".file-filter").focus();
  await page.keyboard.press("ControlOrMeta+v");
  await page.locator(".file-filter").blur();
  await expect(page.locator(".clash-bar")).toHaveCount(0);
});
