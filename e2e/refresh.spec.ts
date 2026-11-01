import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { harness, lines, numbered } from "./harness";

const { commitAll, git, initRepo, launch } = harness();
let repo: string;
let page: Page;

const { body, edit } = numbered(300);
const write = (list: string[]) => writeFileSync(join(repo, "a.ts"), lines(list));

test.beforeAll(async () => {
  repo = initRepo();
  write(body);
  writeFileSync(join(repo, "b.ts"), "export const b = 1;\n");
  commitAll("init");
  write(edit(150));

  ({ page } = await launch(repo));
  await expect(page.locator(".file")).toHaveCount(1);
});

const topLine = () =>
  page.evaluate(() => {
    const top = document.querySelector(".scroller")!.getBoundingClientRect().top;
    const cells = [...document.querySelectorAll(".cell.b")].filter((c) => c.getBoundingClientRect().top >= top);
    cells.sort((x, y) => x.getBoundingClientRect().top - y.getBoundingClientRect().top);
    return cells[0]?.textContent;
  });

test("edits made outside show up on their own, and the view stays on the same line", async () => {
  await page.keyboard.press("f");
  await page.locator(".scroller").evaluate((el) => {
    el.scrollTop = 4000;
    el.dispatchEvent(new Event("scroll"));
  });
  await expect.poll(topLine).toMatch(/^export const v\d+ = \d+;$/);
  const before = await topLine();

  write(["// header", "// more", ...edit(150)]);
  await expect(page.locator(".file .s-add")).toHaveText("+3");
  await expect(page.locator(".file.is-fresh")).toHaveCount(1);
  await expect.poll(topLine).toBe(before);

  writeFileSync(join(repo, "b.ts"), "export const b = 2;\n");
  await expect(page.locator(".file")).toHaveCount(2);
  git("add", "b.ts");
  await expect(page.locator(".file")).toHaveCount(1);
});

test("focus stays on its hunk when an edit adds a hunk above it", async () => {
  await page.keyboard.press("f");
  const heads = page.locator(".hunk-head");
  await expect(heads).toHaveCount(2);
  await page.keyboard.press("j");
  const focused = page.locator(".hunk-head.is-focus .hh-range");
  const before = await focused.textContent();

  write(["// header", "// more", ...edit(80, 150)]);
  await expect(heads).toHaveCount(3);
  await expect(focused).toHaveText(before!);
});

test("a view visited earlier never shows its file list from before an outside change", async () => {
  const picker = page.locator(".picker-btn");
  await page.keyboard.press("3");
  await expect(picker).toHaveText("All since last commit");
  await page.keyboard.press("1");
  await expect(picker).toHaveText("Unstaged");
  writeFileSync(join(repo, "c.ts"), "export const c = 1;\n");
  await expect(page.locator(".file", { hasText: "c.ts" })).toHaveCount(1);

  await page.evaluate(() => {
    const w = window as unknown as { stale: number };
    w.stale = 0;
    const look = () => {
      const all = document.querySelector(".picker-btn")?.textContent === "All since last commit";
      const names = [...document.querySelectorAll(".file .name")].map((n) => n.textContent);
      if (all && !names.includes("c.ts")) w.stale++;
    };
    new MutationObserver(look).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  await page.keyboard.press("3");
  await expect(page.locator(".file", { hasText: "c.ts" })).toHaveCount(1);
  await expect(picker).toHaveText("All since last commit");
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (window as unknown as { stale: number }).stale)).toBe(0);
  await page.keyboard.press("1");
});

test("a selection stays put while lines change elsewhere, and clears when its own lines change", async () => {
  write(body.map((l, i) => (i === 30 ? l.replace("= 30", "= 3000") : l)));
  await page.locator(".file", { hasText: "a.ts" }).click();
  await expect(page.locator(".cell.b", { hasText: "3000" })).toBeVisible();
  const bLine = (n: number) => page.locator(".ln.b[data-line]", { hasText: new RegExp(`^${n}$`) });
  await bLine(30).click();
  await bLine(31).click({ modifiers: ["Shift"] });
  const picked = page.locator(".cell.b.sel");
  await expect(picked).toHaveText(["export const v29 = 29;", "export const v30 = 3000;"]);

  write(["// one", "// two", ...body.map((l, i) => (i === 30 ? l.replace("= 30", "= 3000") : l))]);
  await expect(page.locator(".hunk-head")).toHaveCount(2);
  await expect(picked).toHaveText(["export const v29 = 29;", "export const v30 = 3000;"]);
  await expect(page.locator(".ln.b.sel")).toHaveText(["32", "33"]);

  write(["// one", "// two", ...body.map((l, i) => (i === 30 ? l.replace("= 30", "= 30000") : l))]);
  await expect(page.locator(".cell.b", { hasText: "30000" })).toBeVisible();
  await expect(picked).toHaveCount(0);
});
