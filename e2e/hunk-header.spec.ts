import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { harness } from "./harness";

const { git, initRepo, launch, shot } = harness();
let repo: string;
let page: Page;

const steps = (tag: string) => Array.from({ length: 80 }, (_, i) => `  const step${i} = load("${tag}", ${i});\n`).join("");
const source = (tag: string) =>
  `export function first() {\n  return 1;\n}\n\nexport function second() {\n${steps(tag)}}\n${"\n".repeat(80)}export const last = "${tag}";\n`;
const scrollTo = (top: number) => page.locator(".diff-scroller").evaluate((el, y) => void (el.scrollTop = y), top);
const distanceFromTop = async (head: ReturnType<Page["locator"]>) => {
  const [box, scroller] = await Promise.all([head.boundingBox(), page.locator(".diff-scroller").boundingBox()]);
  return Math.round(box!.y - scroller!.y);
};

test.beforeAll(async () => {
  repo = initRepo();
  writeFileSync(join(repo, "a.ts"), source("old"));
  git("add", "-A");
  git("commit", "-qm", "init");
  writeFileSync(join(repo, "a.ts"), source("new"));
  ({ page } = await launch(repo, { prefs: { layout: "split", theme: "light" } }));
  await expect(page.locator(".hunk-head").first()).toBeVisible();
});

test("the hunk header leads with the highlighted function", async () => {
  const head = page.locator(".hunk-head").first();
  await expect(head.locator(".hh-ctx")).toContainText("export function first() {");
  await expect(head.locator(".hh-ctx [style*='color']").first()).toBeVisible();
});

test("a hunk header stays at the top until its hunk scrolls away", async () => {
  const head = page.locator(".hunk-track .hunk-head").first();
  await scrollTo(800);
  await expect.poll(() => distanceFromTop(head)).toBe(0);
  await shot("sticky-head");
  await head.hover();
  await expect(head.getByRole("button", { name: "Stage hunk" })).toBeVisible();

  await page.keyboard.press("f");
  await expect.poll(() => page.locator(".diff").evaluate((el) => el.clientHeight)).toBeGreaterThan(2200);
  const first = page.locator(".vrow.hunk-track").first();
  const end = await first.evaluate((el) => (el as HTMLElement).offsetTop + (el as HTMLElement).offsetHeight);
  await expect
    .poll(async () => {
      await scrollTo(end - 10);
      return distanceFromTop(head);
    })
    .toBeLessThan(0);
  await page.keyboard.press("f");
});

test("dragging line numbers up past a stuck header keeps extending the selection", async () => {
  await scrollTo(1000);
  const scroller = (await page.locator(".diff-scroller").boundingBox())!;
  const line = page.locator(".ln.b.add", { hasText: /^70$/ });
  const box = (await line.boundingBox())!;
  await page.mouse.move(box.x + 5, box.y + 5);
  await page.mouse.down();
  await page.mouse.move(box.x + 5, box.y - 40, { steps: 3 });
  const before = await page.locator(".ln.b.sel").count();
  await page.mouse.move(box.x + 5, scroller.y + 4, { steps: 3 });
  await expect.poll(() => page.locator(".diff-scroller").evaluate((el) => el.scrollTop)).toBeLessThan(900);
  await page.mouse.up();
  const selected = await page.locator(".sel-count").first().textContent();
  expect(parseInt(selected!)).toBeGreaterThan(before + 5);
  await page.keyboard.press("Escape");
});
