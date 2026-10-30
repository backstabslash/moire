import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { harness } from "./harness";

const { git, initRepo, launch, shot, tmp } = harness();
let repo: string;
let outside: string;
let app: ElectronApplication;
let page: Page;

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
    const seen = globalThis as { reads?: number };
    seen.reads = 0;
    ipcMain.removeHandler("files:clipboard");
    ipcMain.handle("files:clipboard", () => {
      seen.reads!++;
      return list;
    });
  }, paths);
const clipboardReads = () => app.evaluate(() => (globalThis as { reads?: number }).reads);

test.beforeAll(async () => {
  repo = initRepo();
  outside = tmp("downloads");
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

  ({ app, page } = await launch(repo));
  await expect(page.locator(".file")).toHaveCount(1);
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
  expect(git("status", "--porcelain")).toBe(" M src/app.ts\n");
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

  await stubClipboard([join(outside, "format.ts")]);
  await page.locator(".file-filter").focus();
  await page.keyboard.press("ControlOrMeta+v");
  // IPC runs in order, so a paste from the filter would be counted before this read.
  await page.evaluate(() => (window as unknown as { moire: { clipboardFiles(): Promise<string[]> } }).moire.clipboardFiles());
  expect(await clipboardReads()).toBe(1);
  await page.locator(".file-filter").blur();
  await page.keyboard.press("ControlOrMeta+v");
  await expect(page.locator(".clash-bar")).toBeVisible();
  await page.keyboard.press("Escape");
});
