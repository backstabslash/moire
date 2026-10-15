import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, type ElectronApplication, expect, type Page, test } from "@playwright/test";

let repo: string;
let userData: string;
let app: ElectronApplication;
let page: Page;
const errors: string[] = [];

const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args]);
const nav = () => page.getByRole("navigation", { name: "All files" });
const dir = (name: string) => nav().locator(".tree-dir", { has: page.locator(".name", { hasText: new RegExp(`^${name}$`) }) });

// Records every state the tree is drawn in, per DOM change and per frame: its open folders, or "empty".
const watchTree = () =>
  page.evaluate(() => {
    const w = window as unknown as { seen: Set<string> };
    w.seen = new Set();
    const look = () => {
      const nav = document.querySelector('nav[aria-label="All files"]');
      if (!nav) return;
      const rows = nav.querySelectorAll(".file, .tree-dir").length;
      const open = [...nav.querySelectorAll('.tree-dir[aria-expanded="true"] .name')].map((n) => n.textContent).join(",");
      w.seen.add(rows ? open : "empty");
      if (!document.querySelector(".side-head .count")?.textContent) w.seen.add("no count");
    };
    new MutationObserver(look).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    const frame = () => {
      look();
      requestAnimationFrame(frame);
    };
    frame();
  });
const seen = () => page.evaluate(() => [...(window as unknown as { seen: Set<string> }).seen]);

test.beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "moire-e2e-repo-"));
  userData = mkdtempSync(join(tmpdir(), "moire-e2e-data-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "e2e@example.com");
  git("config", "user.name", "e2e");
  for (const d of ["src", "docs", "lib/deep"]) mkdirSync(join(repo, d), { recursive: true });
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(repo, "docs", "guide.md"), "# Guide\n");
  writeFileSync(join(repo, "lib", "deep", "x.ts"), "export const x = 1;\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 2;\n");
  writeFileSync(join(repo, "docs", "guide.md"), "# Guide\n\nMore.\n");
  git("add", "docs/guide.md");

  app = await electron.launch({ args: [resolve("."), `--user-data-dir=${userData}`, repo], env: { ...process.env, MOIRE_HIDDEN: "1" } });
  page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  await expect(page.locator(".file")).toHaveCount(1);
});

test.afterAll(async () => {
  await app?.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(userData, { recursive: true, force: true });
});

test.afterEach(() => {
  expect(errors).toEqual([]);
});

test("opened folders survive mode switches, and the tree never blanks meanwhile", async () => {
  await page.keyboard.press("a");
  await expect(dir("src")).toHaveAttribute("aria-expanded", "true");
  await dir("lib").click();
  await dir("deep").click();
  await expect(nav().getByTitle(/^lib\/deep\/x\.ts/)).toBeVisible();

  await watchTree();
  const names: Record<string, string> = { "1": "Unstaged", "2": "Staged", "3": "All since last commit" };
  for (const key of ["2", "3", "1"]) {
    await page.keyboard.press(key);
    await expect(page.locator(".picker-btn")).toHaveText(names[key]);
  }
  await page.waitForTimeout(300);
  expect(await seen()).toEqual(["lib,deep,src"]);
});

test("a twice keeps opened folders, open from the first frame", async () => {
  await watchTree();
  await page.keyboard.press("a");
  await expect(page.getByRole("navigation", { name: "Changed files" })).toBeVisible();
  await page.keyboard.press("a");
  await expect(nav().getByTitle(/^lib\/deep\/x\.ts/)).toBeVisible();
  await page.waitForTimeout(300);
  expect(await seen()).toEqual(["lib,deep,src"]);
});

test("the active file's folder can be closed, and opens again when a file in it is picked", async () => {
  await dir("src").click();
  await expect(nav().getByTitle(/^src\/a\.ts/)).toHaveCount(0);
  await page.keyboard.press("a");
  await page.keyboard.press("a");
  await expect(dir("src")).toHaveAttribute("aria-expanded", "false");

  await dir("docs").click();
  await nav()
    .getByTitle(/^docs\/guide\.md/)
    .click();
  await expect(dir("src")).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("p");
  await page.keyboard.type("src/a.ts");
  await page.keyboard.press("Enter");
  await page.locator(".file-filter").press("Escape");
  await expect(dir("src")).toHaveAttribute("aria-expanded", "true");
  await expect(nav().locator(".file.is-active .name")).toHaveText("a.ts");
});
