import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { harness } from "./harness";

const { git, initRepo, launch, open, shot, shots } = harness();
let repo: string;
let page: Page;

const write = (path: string, text: string) => {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), text);
};
const lines = (name: string, n: number, from = 0) => Array.from({ length: n }, (_, i) => `export const ${name}${i} = ${i + from};`).join("\n") + "\n";
const shown = () => page.locator(".files .file").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.path!));
const row = (name: string) => page.locator(`.file[data-path$="${name}"]`);
const numbered = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`);

const LISTED = [
  "package.json",
  "pnpm-lock.yaml",
  "docs/checkout.md",
  "src/lib/format.ts",
  "src/lib/format.test.ts",
  "src/lib/round.ts",
  "src/other/index.ts",
  "src/ui/Cart.module.css",
  "src/ui/Cart.tsx",
  "src/ui/Cart.test.tsx",
  "tests/e2e/Cart.test.ts",
  "web/page.py",
  "zz/gone.txt",
  "zz/logo.bin",
  "zz/shift.txt",
];

test.beforeAll(async () => {
  repo = initRepo();
  for (const path of LISTED) write(path, lines("v", 30));
  write("src/other/index.ts", "export const a = 1;\n");
  write("zz/logo.bin", "\x00\x00\x01");
  write("zz/shift.txt", numbered.join("\n") + "\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  for (const path of LISTED) write(path, lines("v", 32, 1));
  write("src/other/index.ts", "export const a = 2;\nexport const b = 3;\n");
  write("zz/logo.bin", "\x00\x00\x02");
  rmSync(join(repo, "zz/gone.txt"));
  write("zz/shift.txt", [...Array.from({ length: 30 }, (_, i) => `new ${i + 1}`), ...numbered.filter((_, i) => i !== 59)].join("\n") + "\n");
  ({ page } = await launch(repo, { prefs: { theme: "light" } }));
  await expect(page.locator(".files .file")).toHaveCount(LISTED.length);
});

test("a changed test tucks under its code, and folders keep their real names", async () => {
  expect(await shown()).toEqual(LISTED);
  await expect(page.locator(".files .dir bdi")).toHaveText(["docs", "src/lib", "src/other", "src/ui", "tests/e2e", "web", "zz"]);
  await expect(page.locator(".file.sib .name")).toHaveText([".test.ts", ".test.tsx"], { useInnerText: true });
  await expect(page.locator(".file.sib").first()).toHaveAttribute("data-tip", /^src\/lib\/format\.test\.ts/);
  await expect(page.locator('.file[data-path="tests/e2e/Cart.test.ts"]')).not.toHaveClass(/sib/);
  await shots("tucked", page.locator(".sidebar"));

  await page.locator(".files .file").first().click();
  for (const path of LISTED) {
    await expect(page.locator(".file.is-active")).toHaveAttribute("data-path", path);
    await page.keyboard.press("]");
  }
});

test("a filter that leaves out the code shows the test as a plain row", async () => {
  await page.keyboard.press("p");
  await page.keyboard.type("format.test");
  expect(await shown()).toEqual(["src/lib/format.test.ts"]);
  await expect(page.locator(".file.sib")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.locator(".files .file")).toHaveCount(LISTED.length);
});

test("the file filter narrows the list and what [ ] walk", async () => {
  await page.keyboard.press("p");
  await page.keyboard.type("lck");
  await expect(page.locator(".file")).toHaveCount(1);
  await expect(page.locator(".side-head .count")).toHaveText(`1 of ${LISTED.length}`);
  await page.keyboard.press("Enter");
  await expect(page.locator(".file.is-active .name")).toHaveText("pnpm-lock.yaml");
  await page.keyboard.press("]");
  await expect(page.locator(".file.is-active .name")).toHaveText("pnpm-lock.yaml");
  await page.locator(".file-filter").focus();
  await page.keyboard.press("Escape");
  await expect(page.locator(".file")).toHaveCount(LISTED.length);
});

test("files show their language as a mark, and role glyphs stay for the rest", async () => {
  await expect(row("src/lib/round.ts").locator(".glyph-lang")).toHaveAttribute("data-mark", "TS");
  await expect(row("src/ui/Cart.module.css").locator(".glyph-lang")).toHaveAttribute("data-mark", "#");
  await expect(row("web/page.py").locator(".glyph-lang")).toHaveAttribute("data-mark", "PY");
  await shots("file-marks");
});

test("status letters line up whatever a row shows, and line counts stack on the open file", async () => {
  await open("web/page.py");
  const left = (name: string) =>
    row(name)
      .locator(".kind")
      .evaluate((el) => el.getBoundingClientRect().left);
  const before = await left("zz/shift.txt");
  expect(await left("zz/logo.bin")).toBe(before);
  expect(await left("zz/gone.txt")).toBe(before);
  expect(await left("web/page.py")).toBe(before);
  await expect(row("zz/logo.bin").locator(".nums")).toHaveText("bin");

  const shift = row("zz/shift.txt");
  const height = (await shift.boundingBox())!.height;
  await page.mouse.move(0, 0);
  await expect(shift.locator(".gauge")).toBeVisible();
  await expect(shift.locator(".s-add")).toBeHidden();
  await shot("file-gauge-light");
  await open("zz/shift.txt");
  await expect(shift.locator(".gauge")).toBeHidden();
  await expect(shift.locator(".line-stack")).toHaveText("+30−1");
  await page.mouse.move(0, 0);
  await expect(shift.locator(".s-add")).toBeVisible();
  expect((await shift.boundingBox())!.height).toBe(height);
  expect(await left("zz/shift.txt")).toBe(before);
  await page.keyboard.press("t");
  await shot("file-gauge-dark");
  await page.keyboard.press("t");
});

test("folder rows collapse with a summary, and reopen when a file inside comes up", async () => {
  const folder = page.locator(".dir", { hasText: "other" });
  await open("src/lib/round.ts");
  await folder.click();
  await expect(row("src/other/index.ts")).toHaveCount(0);
  await expect(page.locator(".dir-sum")).toContainText("+2");
  await shot("folder-shut");
  await folder.click();
  await expect(row("src/other/index.ts")).toBeVisible();

  await folder.click();
  await expect(row("src/other/index.ts")).toHaveCount(0);
  await page.keyboard.press("]");
  await expect(row("src/other/index.ts")).toBeVisible();
  await expect(page.locator(".file.is-active")).toHaveAttribute("data-path", "src/other/index.ts");
});

test("a filter looks inside collapsed folders, without opening them for good", async () => {
  const folder = page.locator(".dir", { hasText: "other" });
  await open("src/lib/round.ts");
  await folder.click();
  await expect(row("src/other/index.ts")).toHaveCount(0);
  await page.locator(".file-filter").fill("src/");
  await expect(row("src/other/index.ts")).toBeVisible();
  await page.locator(".file-filter").fill("");
  await expect(row("src/other/index.ts")).toHaveCount(0);
  await folder.click();
  await expect(row("src/other/index.ts")).toBeVisible();
});

test("staged files dim in place in the All view", async () => {
  git("add", "src/ui/Cart.module.css", "src/lib/format.test.ts");
  await page.keyboard.press("3");
  await expect(page.locator(".file.is-staged")).toHaveCount(2);
  expect(await shown()).toEqual(LISTED);
  await page.keyboard.press("1");
});
