import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { harness } from "./harness";

const { git, initRepo, launch, shots } = harness();
let repo: string;
let page: Page;

test.beforeAll(async () => {
  repo = initRepo();
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

  ({ page } = await launch(repo));
  await expect(page.locator(".file")).toHaveCount(1);
});

test("a shows every file, with ignored ones, and opens an unchanged file whole", async () => {
  await page.keyboard.press("a");
  const nav = page.getByRole("navigation", { name: "All files" });
  await expect(nav.locator(".tree-dir")).toHaveText(["out", "src"]);
  await expect(nav.locator(".file.is-ignored")).toHaveText("IDEAS.md");
  await expect(nav.locator(".file .name")).toHaveText(["a.ts", "util.ts", ".gitignore", "IDEAS.md"]);

  await nav.locator('[data-tip^="IDEAS.md"]').click();
  await expect(page.locator('.pane-h b[data-tip="Working tree, IDEAS.md, unchanged"]')).toBeVisible();
  await expect(page.locator(".row.uni .cell")).toHaveText(["# Ideas", "", "- a file tree"]);

  await page.keyboard.press("s");
  await expect(page.locator(".toast.show")).toContainText("IDEAS.md has no changes here");
});

test("an ignored folder is read when opened", async () => {
  const nav = page.getByRole("navigation", { name: "All files" });
  await nav.locator(".tree-dir", { hasText: "out" }).click();
  await nav.locator('[data-tip^="out/bundle.js"]').click();
  await expect(page.locator(".row.uni .cell")).toHaveText(["console.log('built');"]);
  await shots("tree");
});

test("an open ignored folder shows files as they're added and removed", async () => {
  const nav = page.getByRole("navigation", { name: "All files" });
  writeFileSync(join(repo, "out", "later.js"), "later\n");
  await expect(nav.locator('[data-tip^="out/later.js"]')).toBeVisible();
  rmSync(join(repo, "out", "later.js"));
  await expect(nav.locator('[data-tip^="out/later.js"]')).toHaveCount(0);
});

test("switching between unchanged files keeps the last one up until the next is ready", async () => {
  await page.evaluate(() => {
    const w = window as unknown as { gaps: number };
    w.gaps = 0;
    const check = () => {
      if (!document.querySelector("main.main") || document.querySelector(".empty-state")) w.gaps++;
    };
    new MutationObserver(check).observe(document.body, { childList: true, subtree: true });
  });
  const nav = page.getByRole("navigation", { name: "All files" });
  for (const name of [".gitignore", "src/util.ts", "IDEAS.md", "src/util.ts"]) {
    await nav.locator(`[data-path="${name}"]`).click();
    await expect(page.locator(`.pane-h b[data-tip$="${name}, unchanged"]`)).toBeVisible();
  }
  expect(await page.evaluate(() => (window as unknown as { gaps: number }).gaps)).toBe(0);
});

test("the filter covers every file, and the open file follows edits", async () => {
  await page.keyboard.press("p");
  await page.keyboard.type("util");
  await page.keyboard.press("Enter");
  await expect(page.locator('.pane-h b[data-tip$="src/util.ts, unchanged"]')).toBeVisible();
  await page.locator(".file-filter").press("Escape");

  writeFileSync(join(repo, "src", "util.ts"), "export function helper() {\n  return 43;\n}\n");
  await page.keyboard.press("r");
  await expect(page.locator(".file.is-active .kind")).toHaveText("M");
  await expect(page.locator('.pane-h b[data-tip$=", unchanged"]')).toHaveCount(0);
});

test("going back to changed files leaves the tree", async () => {
  await page.locator('[data-tip^="IDEAS.md"]').click();
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
