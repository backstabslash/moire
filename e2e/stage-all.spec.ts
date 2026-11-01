import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { harness, lines, numbered, staged } from "./harness";

const { commitAll, idle, initRepo, launch, shot, shots } = harness();
let repo: string;
let page: Page;

const { body } = numbered(30);
const edited = lines(body.map((l, i) => (i === 3 || i === 23 ? l.replace("=", "= 1 +") : l)));

test.beforeAll(async () => {
  repo = initRepo();
  writeFileSync(join(repo, "a.ts"), lines(body));
  writeFileSync(join(repo, "img.bin"), Buffer.from([0, 1, 2, 3]));
  commitAll("init");
  writeFileSync(join(repo, "a.ts"), edited);
  writeFileSync(join(repo, "img.bin"), Buffer.from([0, 9, 9, 9]));
  writeFileSync(join(repo, "new.ts"), "export const fresh = true;\n");

  ({ page } = await launch(repo));
  await expect(page.locator(".file")).toHaveCount(3);
});

test("hunk buttons don't keep focus, so Enter can't repeat a discard on the next hunk", async () => {
  await page.locator(".file", { hasText: "a.ts" }).click();
  await idle();
  await page.locator(".hunk-head").first().hover();
  await page.locator(".hunk-head").first().locator(".hh-discard").click();
  await expect(page.locator(".toast.show")).toContainText("Discarded 2 lines in a.ts");
  await expect(page.locator(".hunk-head")).toHaveCount(1);
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("BUTTON");
  await page.keyboard.press("Enter");
  await expect(page.locator(".hunk-head")).toHaveCount(1);
  await page.keyboard.press("u");
  await expect(page.locator(".hunk-head")).toHaveCount(2);
  expect(readFileSync(join(repo, "a.ts"), "utf8")).toBe(edited);
});

test("Discard file throws away a binary file whole, and u brings it back", async () => {
  await page.locator(".file", { hasText: "img.bin" }).click();
  await idle();
  await shot("discard-file");
  await page.getByRole("button", { name: "Discard file" }).click();
  await expect(page.locator(".toast.show")).toContainText("Discarded img.bin");
  await expect(page.locator(".file")).toHaveCount(2);
  expect(readFileSync(join(repo, "img.bin"))).toEqual(Buffer.from([0, 1, 2, 3]));
  await page.keyboard.press("u");
  await expect(page.locator(".file")).toHaveCount(3);
  expect(readFileSync(join(repo, "img.bin"))).toEqual(Buffer.from([0, 9, 9, 9]));
});

test("a discard whose file changed since can't be undone, but can be saved next to it", async () => {
  await page.locator(".file", { hasText: "new.ts" }).click();
  await idle();
  await page.getByRole("button", { name: "Discard file" }).click();
  await expect(page.locator(".toast.show")).toContainText("Discarded new.ts");
  writeFileSync(join(repo, "new.ts"), "an agent wrote this\n");
  await expect(page.locator(".file", { hasText: "new.ts" })).toBeVisible();
  await idle();
  await page.keyboard.press("u");
  await expect(page.locator(".toast.show")).toContainText('Can\'t undo "Discarded new.ts": new.ts changed since.');
  await shots("refused-undo");
  await page.getByRole("button", { name: "Save as new.ts.orig" }).click();
  await expect(page.locator(".toast.show")).toContainText("Saved new.ts.orig");
  expect(readFileSync(join(repo, "new.ts.orig"), "utf8")).toBe("export const fresh = true;\n");
  rmSync(join(repo, "new.ts.orig"));
  rmSync(join(repo, "new.ts"));
  await expect(page.locator(".file")).toHaveCount(2);
});

test("Stage all stages every file as one step, and Unstage all puts them back", async () => {
  await idle();
  await page.locator(".stage-progress").getByRole("button", { name: "Stage all" }).click();
  await expect(page.locator(".toast.show")).toContainText("Staged 2 files");
  await expect.poll(() => staged(repo)).toEqual(["a.ts", "img.bin"]);
  await page.keyboard.press("u");
  await expect.poll(() => staged(repo)).toEqual([]);
  await idle();
  await page.keyboard.press("Shift+S");
  await expect.poll(() => staged(repo)).toEqual(["a.ts", "img.bin"]);
  await page.keyboard.press("2");
  await idle();
  await expect(page.locator(".commit-box").getByRole("button", { name: "Unstage all" }).locator("kbd")).toHaveText("shift s");
  await page.keyboard.press("Shift+S");
  await expect(page.locator(".toast.show")).toContainText("Unstaged 2 files");
  await expect.poll(() => staged(repo)).toEqual([]);
  await page.keyboard.press("1");
});
