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
const shot = (name: string) => process.env.MOIRE_SHOTS && page.screenshot({ path: join(process.env.MOIRE_SHOTS, `${name}.png`) });

test.beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "moire-e2e-repo-"));
  userData = mkdtempSync(join(tmpdir(), "moire-e2e-data-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "e2e@example.com");
  git("config", "user.name", "e2e");
  writeFileSync(join(repo, ".gitignore"), "IDEAS.md\nout/\n");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(repo, "src", "util.ts"), "export function helper() {\n  return 42;\n}\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 2;\n");
  writeFileSync(join(repo, "IDEAS.md"), "# Ideas\n\n- a file tree\n");
  mkdirSync(join(repo, "out"));
  writeFileSync(join(repo, "out", "bundle.js"), "console.log('built');\n");

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

test("a shows every file, with ignored ones, and opens an unchanged file whole", async () => {
  await page.keyboard.press("a");
  const nav = page.getByRole("navigation", { name: "All files" });
  await expect(nav.locator(".tree-dir")).toHaveText(["out", "src1"]);
  await expect(nav.locator(".file.is-ignored")).toHaveText("IDEAS.md");
  await expect(nav.locator(".file .name")).toHaveText(["a.ts", "util.ts", ".gitignore", "IDEAS.md"]);

  await nav.getByTitle(/^IDEAS\.md/).click();
  await expect(page.locator(".pane-h")).toContainText("Working tree, IDEAS.md, unchanged");
  await expect(page.locator(".row.uni .cell")).toHaveText(["# Ideas", "", "- a file tree"]);

  await page.keyboard.press("s");
  await expect(page.locator(".toast.show")).toContainText("IDEAS.md has no changes here");
});

test("an ignored folder is read when opened", async () => {
  const nav = page.getByRole("navigation", { name: "All files" });
  await nav.locator(".tree-dir", { hasText: "out" }).click();
  await nav.getByTitle(/^out\/bundle\.js/).click();
  await expect(page.locator(".row.uni .cell")).toHaveText(["console.log('built');"]);
  await shot("tree-light");
  await page.keyboard.press("t");
  await shot("tree-dark");
  await page.keyboard.press("t");
});

test("the filter covers every file, and the open file follows edits", async () => {
  await page.keyboard.press("p");
  await page.keyboard.type("util");
  await page.keyboard.press("Enter");
  await expect(page.locator(".pane-h")).toContainText("src/util.ts, unchanged");
  await page.locator(".file-filter").press("Escape");

  writeFileSync(join(repo, "src", "util.ts"), "export function helper() {\n  return 43;\n}\n");
  await page.keyboard.press("r");
  await expect(page.locator(".file.is-active .kind")).toHaveText("M");
  await expect(page.locator(".pane-h").first()).not.toContainText("unchanged");
});

test("going back to changed files leaves the tree", async () => {
  await page.getByTitle(/^IDEAS\.md/).click();
  await page.keyboard.press("a");
  await expect(page.getByRole("navigation", { name: "Changed files" }).locator(".file")).toHaveCount(2);
  await expect(page.locator(".file.is-active .name")).toHaveText("a.ts");
});

test("each view keeps its own filter", async () => {
  const input = page.locator(".file-filter");
  await page.keyboard.press("p");
  await page.keyboard.type("util");
  await page.keyboard.press("Enter");
  await page.keyboard.press("a");
  await expect(input).toHaveValue("");
  await expect(page.locator(".tree-dir")).not.toHaveCount(0);
  await page.keyboard.press("a");
  await expect(input).toHaveValue("util");
  await expect(page.locator(".file")).toHaveCount(1);
});
