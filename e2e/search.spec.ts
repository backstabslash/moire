import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { harness, lines, numbered } from "./harness";

const { commitAll, initRepo, launch, open, shot } = harness();
let repo: string;
let page: Page;

const { body, edit } = numbered(60);

test.beforeAll(async () => {
  repo = initRepo();
  writeFileSync(join(repo, "a.ts"), lines(body));
  writeFileSync(join(repo, "b.ts"), lines(body));
  writeFileSync(join(repo, "IDEAS.md"), "# Ideas\n\n- a file tree\n");
  commitAll("init");
  writeFileSync(join(repo, "a.ts"), lines(edit(3)));
  writeFileSync(join(repo, "b.ts"), lines(body.map((l, i) => (i === 25 ? l.replace("= 25", "= 99") : l))));

  ({ page } = await launch(repo));
  await expect(page.locator(".file")).toHaveCount(2);
});

test("search finds hits in folded context and in other files", async () => {
  await page.keyboard.press("Control+f");
  const input = page.getByRole("textbox", { name: "Search" });
  await expect(input).toBeFocused();
  await input.fill("v25 ");
  await expect(page.locator(".search-status")).toHaveText("1 of 3");
  await expect(page.locator("mark.hit.is-current")).toHaveText(["v25 ", "v25 "]);
  await expect(page.locator(".file.is-active .name")).toHaveText("a.ts");
  await expect(page.locator(".file", { hasText: "b.ts" }).locator(".hit-count")).toHaveText("2");
  await shot("search");

  await input.press("Enter");
  await expect(page.locator(".search-status")).toHaveText("2 of 3");
  await expect(page.locator(".file.is-active .name")).toHaveText("b.ts");
  await expect(page.locator(".cell.a mark.hit.is-current")).toHaveText("v25 ");
  await input.press("Shift+Enter");
  await expect(page.locator(".file.is-active .name")).toHaveText("a.ts");

  await page.getByRole("button", { name: "Search side B only" }).click();
  await expect(page.locator(".search-status")).toHaveText(/of 2$/);
  await page.getByRole("button", { name: "Regular expression" }).click();
  await input.fill("v2[0-9] = 99");
  await expect(page.locator(".search-status")).toHaveText("1 of 1");
  await expect(page.locator(".file.is-active .name")).toHaveText("b.ts");
  await input.fill("(");
  await expect(page.locator(".search-status")).toHaveText("Invalid pattern");

  await input.press("Escape");
  await expect(page.locator(".search")).toHaveCount(0);
  await expect(page.locator("mark.hit")).toHaveCount(0);
  await page.keyboard.press("/");
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("(");
  await input.press("Escape");
});

test("opening and closing search leaves the diff lines where they were", async () => {
  await open("a.ts");
  await page.keyboard.press("f");
  await page.locator(".diff-scroller").evaluate((el) => {
    el.scrollTop = 300;
    el.dispatchEvent(new Event("scroll"));
  });
  const line = page.locator(".cell.b", { hasText: "export const v30 = 30;" });
  const top = async () => (await line.boundingBox())!.y;
  const before = await top();
  await page.keyboard.press("Control+f");
  await expect(page.locator(".search")).toBeVisible();
  expect(await top()).toBe(before);
  await page.keyboard.press("Escape");
  await expect(page.locator(".search")).toHaveCount(0);
  expect(await top()).toBe(before);
  await page.keyboard.press("f");
});

test("search covers a whole unchanged file, and its Markdown preview keeps the query", async () => {
  await page.keyboard.press("a");
  await page.getByRole("navigation", { name: "All files" }).locator('[data-tip^="IDEAS.md"]').click();
  await expect(page.locator(".row.uni .cell")).toHaveText(["# Ideas", "", "- a file tree"]);

  await page.keyboard.press("/");
  await expect(page.locator(".search input")).toBeFocused();
  await page.locator(".search input").fill("tree");
  await expect(page.locator(".search-status")).toHaveText("1 of 1");
  await expect(page.locator("mark.hit.is-current")).toHaveText("tree");
  await page.keyboard.press("Escape");
  await page.keyboard.press("m");
  await expect(page.locator("article.md h1")).toHaveText("Ideas");
  await page.keyboard.press("/");
  await expect(page.locator(".search input")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect.poll(() => page.evaluate(() => CSS.highlights.get("moire-hit-now")?.size ?? 0)).toBe(0);
  await page.keyboard.press("/");
  await expect(page.locator(".search input")).toHaveValue("tree");
  await expect.poll(() => page.evaluate(() => CSS.highlights.get("moire-hit-now")?.size ?? 0)).toBe(1);
  await page.keyboard.press("Escape");
  await page.keyboard.press("m");
  await page.keyboard.press("a");
});
