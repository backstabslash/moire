import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { harness } from "./harness";

// Chromium's own copy writes straight to the system clipboard, so every test relying on it lives here, where none can overlap.
const { clipboard, git, initRepo, launch, open } = harness();
let app: ElectronApplication;
let page: Page;

const body = Array.from({ length: 30 }, (_, i) => `export const v${i + 1} = ${i + 1};`);
const edited = body.map((l, i) => (i === 4 || i === 15 ? l.replace("=", "= 10 *") : l));
const cell = (n: number) => page.locator(".row.split", { has: page.locator(".ln.b[data-line]", { hasText: new RegExp(`^${n}$`) }) }).locator(".cell.b");

test.beforeAll(async () => {
  const repo = initRepo();
  const write = (file: string, text: string) => writeFileSync(join(repo, file), text);
  write("a.ts", body.join("\n") + "\n");
  write("blanks.txt", "one\n\ntwo\nthree\n");
  write("colour.ts", "export const a = 1;\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  write("a.ts", edited.join("\n") + "\n");
  write("blanks.txt", "one\n\ntwo\nthree changed\n");
  write("colour.ts", 'export const a = 2;\nexport const frame = "#1f252c";\n');

  ({ app, page } = await launch(repo, { prefs: { layout: "split", theme: "light" }, systemClipboard: true }));
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator(".file")).toHaveCount(3);
});

test("a text drag across two hunks copies one side, without header text or duplicates", async () => {
  await app.evaluate(({ clipboard }) => clipboard.writeText(""));
  await open("a.ts");
  await expect(page.locator(".hunk-head")).toHaveCount(2);
  const from = (await cell(4).boundingBox())!;
  const to = (await cell(14).boundingBox())!;
  await page.mouse.move(from.x + 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
  await page.mouse.move(to.x + to.width - 2, to.y + to.height / 2);
  await page.mouse.up();
  await page.keyboard.press("ControlOrMeta+c");
  await expect.poll(clipboard).toBe([4, 5, 6, 7, 8, 13, 14].map((n) => edited[n - 1]).join("\n"));

  await page.evaluate(() => {
    const textOf = (n: number) => {
      const row = [...document.querySelectorAll(".row.split")].find((r) => r.querySelector(".ln.b")?.textContent === String(n));
      return document.createTreeWalker(row!.querySelector(".cell.b .text")!, NodeFilter.SHOW_TEXT).nextNode()!;
    };
    getSelection()!.setBaseAndExtent(textOf(4), 2, textOf(14), 3);
  });
  await page.keyboard.press("ControlOrMeta+c");
  await expect.poll(clipboard).toBe(["port const v4 = 4;", ...[5, 6, 7, 8, 13].map((n) => edited[n - 1]), "exp"].join("\n"));
  await page.evaluate(() => getSelection()!.removeAllRanges());
});

test("the line menu copies the same text as the keyboard", async () => {
  await open("blanks.txt");
  await page.evaluate(() => {
    const text = (n: number) => document.createTreeWalker(document.querySelectorAll(".cell.b .text")[n], NodeFilter.SHOW_TEXT).nextNode()!;
    getSelection()!.setBaseAndExtent(text(0), 0, text(2), 3);
  });
  await page.keyboard.press("ControlOrMeta+c");
  await expect.poll(clipboard).toBe("one\n\ntwo");
  await page
    .locator(".cell.b .text")
    .first()
    .click({ button: "right", position: { x: 4, y: 6 } });
  await page.locator(".file-menu").getByRole("menuitem", { name: "Copy", exact: true }).click();
  await expect.poll(clipboard).toBe("one\n\ntwo");
  await page.evaluate(() => getSelection()!.removeAllRanges());
});

test("copying a colour leaves its swatch out", async () => {
  await open("colour.ts");
  await expect(page.locator(".cell.add .swatch")).toHaveCount(1);
  await page
    .locator(".cell.add .text")
    .nth(1)
    .evaluate((el) => getSelection()!.selectAllChildren(el));
  await page.keyboard.press("ControlOrMeta+c");
  await expect.poll(clipboard).toBe('export const frame = "#1f252c";');
  await page.evaluate(() => getSelection()!.removeAllRanges());
});
