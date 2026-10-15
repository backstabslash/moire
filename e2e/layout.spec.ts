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
const lines = (changed: number) => Array.from({ length: 30 }, (_, i) => (i === changed ? "changed" : `line ${i}`)).join("\n") + "\n";
const box = async (selector: string) => (await page.locator(selector).first().boundingBox())!;
const height = async (selector: string) => (await box(selector)).height;

async function expectFrame() {
  const viewport = await page.evaluate(() => innerHeight);
  const status = await box(".status");
  expect(status.height).toBe(30);
  expect(status.y + status.height).toBe(viewport);
  for (const selector of [".sidebar", ".sidebar > :last-child", ".main", ".empty-state"]) {
    if (!(await page.locator(selector).count())) continue;
    const area = await box(selector);
    expect(area.height).toBeGreaterThan(selector.includes(">") ? 0 : 100);
    expect(area.y + area.height).toBeLessThanOrEqual(status.y);
  }
}

test.beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "moire-e2e-repo-"));
  userData = mkdtempSync(join(tmpdir(), "moire-e2e-data-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "e2e@example.com");
  git("config", "user.name", "e2e");
  writeFileSync(join(repo, "a.ts"), lines(-1));
  writeFileSync(join(repo, "notes.md"), lines(-1));
  git("add", "-A");
  git("commit", "-qm", "init");
  writeFileSync(join(repo, "a.ts"), lines(3));
  git("add", "a.ts");
  writeFileSync(join(repo, "a.ts"), lines(20));
  writeFileSync(join(repo, "notes.md"), lines(5));

  app = await electron.launch({ args: [resolve("."), `--user-data-dir=${userData}`, repo], env: { ...process.env, MOIRE_HIDDEN: "1" } });
  page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  await expect(page.locator(".file")).toHaveCount(2);
});

test.afterAll(async () => {
  await app?.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(userData, { recursive: true, force: true });
});

test.afterEach(() => {
  expect(errors).toEqual([]);
});

test("the frame and headers keep their size across views", async () => {
  const names: Record<string, string> = { "1": "Unstaged", "2": "Staged", "3": "All since last commit" };
  const heads = new Set<number>();
  const progress = new Set<number>();
  for (const key of ["1", "2", "3"]) {
    await page.keyboard.press(key);
    await expect(page.locator(".toolbar").getByRole("button", { name: names[key], exact: true })).toBeVisible();
    await page.locator(".file", { hasText: "a.ts" }).click();
    await expect(page.locator(".pane-h").first()).toBeVisible();
    await expectFrame();
    heads.add(await height(".panes-head"));
    if (key !== "2") progress.add(await height(".stage-progress"));
  }
  expect([...heads]).toHaveLength(1);
  expect([...progress]).toHaveLength(1);
});

test("a Markdown file's header matches a code file's", async () => {
  await page.keyboard.press("1");
  await page.locator(".file", { hasText: "notes.md" }).click();
  await expect(page.getByRole("button", { name: /Preview/ })).toBeVisible();
  const markdown = await height(".panes-head");
  await page.keyboard.press("3");
  await page.locator(".file", { hasText: "a.ts" }).click();
  await expect(page.getByRole("button", { name: /Stage file/ })).toHaveCount(0);
  expect(await height(".panes-head")).toBe(markdown);
});

test("the empty state keeps the frame", async () => {
  git("add", "-A");
  git("commit", "-qm", "all");
  await page.keyboard.press("r");
  await expect(page.locator(".empty-state h2")).toHaveText("Working tree matches HEAD.");
  await expectFrame();
});

test("a narrow window shows unified for now, and split stays the setting", async () => {
  const html = page.locator("html");
  const resize = (w: number, h: number) => app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setSize(w, h), [w, h]);
  writeFileSync(join(repo, "a.ts"), lines(7));
  await page.keyboard.press("1");
  await page.locator(".file", { hasText: "a.ts" }).click();
  await expect(html).toHaveAttribute("data-layout", "split");

  await resize(1000, 700);
  await expect(html).toHaveAttribute("data-layout", "unified");
  await expect(page.getByRole("button", { name: "Unified" })).toHaveClass("is-auto");
  await expect(page.locator(".toast.show")).toContainText("Unified layout while the window is narrow");

  await page.keyboard.press("v");
  await expect(html).toHaveAttribute("data-layout", "split");
  const clipped = await page.locator(".pane-h .actions button").evaluateAll((els) => els.filter((el) => el.scrollWidth > el.clientWidth).length);
  expect(clipped).toBe(0);

  await resize(1440, 920);
  await expect(html).toHaveAttribute("data-layout", "split");
  expect(await page.evaluate(() => localStorage.getItem("moire.layout"))).toBe("split");
});
