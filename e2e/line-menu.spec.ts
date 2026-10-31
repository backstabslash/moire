import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { harness } from "./harness";

const { git, initRepo, launch, open, shot } = harness();
let repo: string;
let page: Page;

const write = (path: string, text: string) => {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), text);
};
const row = (name: string) => page.locator(`.file[data-path$="${name}"]`);
const numbered = (edits: Record<number, string> = {}) => Array.from({ length: 200 }, (_, i) => edits[i + 1] ?? `line ${i + 1}`).join("\n") + "\n";

test.beforeAll(async () => {
  repo = initRepo();
  write("src/main/index.ts", numbered());
  write("web/page.py", "print(1)\n");
  write("zz/blanks.txt", "one\n\ntwo\nthree\n");
  write("zz/gone.txt", "gone\n");
  write("zz/shift.txt", numbered());
  git("add", "-A");
  git("commit", "-qm", "init");
  write("src/main/index.ts", numbered({ 20: "edit 20", 150: "edit 150" }));
  write("web/page.py", "print(2)\n");
  write("zz/blanks.txt", "one\n\ntwo\nthree changed\n");
  rmSync(join(repo, "zz/gone.txt"));
  const lines = numbered().split("\n");
  lines.splice(59, 1);
  write("zz/shift.txt", [...Array.from({ length: 30 }, (_, i) => `new ${i + 1}`), ...lines].join("\n"));
  ({ page } = await launch(repo, { prefs: { layout: "split", theme: "light" } }));
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator(".hunk-head").first()).toBeVisible();
});

test("a right click on a line offers the actions for it", async () => {
  await open("web/page.py");
  await page.locator(".cell.add").first().click({ button: "right" });
  const menu = page.locator(".file-menu");
  await expect(menu.getByRole("menuitem", { name: "Stage hunk" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Discard hunk" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Copy hunk as Markdown" })).toBeVisible();
  await expect(menu.locator(".file-menu-path")).toContainText("web/page.py:1");
  await shot("line-menu");
  await menu.getByRole("menuitem", { name: "Stage hunk" }).click();
  await expect.poll(() => git("diff", "--cached", "--name-only").trim()).toBe("web/page.py");
  await page.keyboard.press("u");
  await expect.poll(() => git("diff", "--cached", "--name-only").trim()).toBe("");
});

test("a removed line opens next to the change, not at its old number", async () => {
  await open("zz/shift.txt");
  // Opening a file scrolls to its first hunk, and that scroll closes a menu opened just before it.
  await expect(async () => {
    await page.locator(".cell.del").last().click({ button: "right" });
    await expect(page.locator(".file-menu-path")).toContainText("zz/shift.txt:87", { timeout: 500 });
  }).toPass();
  await page.keyboard.press("Escape");
});

test("a deleted file's lines don't offer the editor", async () => {
  await open("zz/gone.txt");
  await page.locator(".cell.del").first().click({ button: "right" });
  await expect(page.locator(".file-menu").getByRole("menuitem", { name: "Open in editor" })).toBeDisabled();
  await expect(page.locator(".file-menu-path")).toHaveText("zz/gone.txt");
  await page.keyboard.press("Escape");
});

test("with only unchanged lines selected, the line menu copies them and offers no staging", async () => {
  await open("zz/blanks.txt");
  await page.locator(".ln.b[data-line]").first().click();
  await page.locator(".cell.b").first().click({ button: "right" });
  const menu = page.locator(".file-menu");
  await expect(menu.getByRole("menuitem", { name: "Copy line as Markdown" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: /^(Stage|Discard) / })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
});

test("a right click outside the selection acts on the line clicked, not the selection", async () => {
  await open("src/main/index.ts");
  await page.locator('.ln.b[data-line="0:4"]').click();
  await page.locator(".cell.add", { hasText: "edit 150" }).click({ button: "right" });
  const menu = page.locator(".file-menu");
  await expect(menu.locator(".file-menu-path")).toContainText("src/main/index.ts:150");
  await menu.getByRole("menuitem", { name: "Stage hunk" }).click();
  await expect.poll(() => git("diff", "--cached")).toContain("+edit 150");
  expect(git("diff", "--cached")).not.toContain("+edit 20");
  await page.keyboard.press("u");
  await expect.poll(() => git("diff", "--cached", "--name-only").trim()).toBe("");
});

test("a right click counts as on the selection only on the side that's selected", async () => {
  await open("web/page.py");
  const old = page.locator(".ln.a.del").first();
  const menu = page.locator(".file-menu");
  await old.click();
  await page.locator(".cell.add").first().click({ button: "right" });
  await expect(menu.getByRole("menuitem", { name: "Discard hunk" })).toBeVisible();
  await page.keyboard.press("Escape");
  await old.click();
  await old.click({ button: "right" });
  await expect(menu.getByRole("menuitem", { name: "Discard line" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
});

test("the line menu says when a selection reaches the whole file", async () => {
  await open("src/main/index.ts");
  await page.keyboard.press("ControlOrMeta+a");
  await page.locator(".cell.add", { hasText: "edit 150" }).click({ button: "right" });
  await expect(page.locator(".file-menu").getByRole("menuitem", { name: "Discard file" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
});

test("the line menu refuses when the file changes while it's open", async () => {
  await open("web/page.py");
  await page.locator(".cell.add").first().click({ button: "right" });
  write("web/page.py", "print(3)\n");
  await expect(page.locator(".cell.add").first()).toContainText("print(3)");
  await page.locator(".file-menu").getByRole("menuitem", { name: "Discard hunk" }).click();
  await expect(page.locator(".toast")).toContainText("changed since you looked");
  expect(git("diff", "--", "web/page.py")).toContain("+print(3)");
  write("web/page.py", "print(2)\n");
  await expect(page.locator(".cell.add").first()).toContainText("print(2)");
});

test("the file menu refuses when the file changes while it's open", async () => {
  await open("web/page.py");
  await row("web/page.py").click({ button: "right" });
  write("web/page.py", "print(3)\n");
  await expect(page.locator(".cell.add").first()).toContainText("print(3)");
  await page.locator(".file-menu").getByRole("menuitem", { name: "Discard file" }).click();
  await expect(page.locator(".toast")).toContainText("changed since you looked");
  expect(git("diff", "--", "web/page.py")).toContain("+print(3)");
  write("web/page.py", "print(2)\n");
  await expect(page.locator(".cell.add").first()).toContainText("print(2)");
});

test("a right click on a file stages it without opening it", async () => {
  await open("src/main/index.ts");
  await row("web/page.py").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Stage file" }).click();
  await expect.poll(() => git("diff", "--cached", "--name-only").trim()).toBe("web/page.py");
  await expect(page.locator(".pane-h b").last()).toHaveText("index.ts");
  await page.keyboard.press("u");
  await expect.poll(() => git("diff", "--cached", "--name-only").trim()).toBe("");
});
