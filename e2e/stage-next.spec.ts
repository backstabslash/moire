import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { harness } from "./harness";

const { git, idle, initRepo, launch } = harness();
let repo: string;
let page: Page;

const body = Array.from({ length: 200 }, (_, i) => `export const v${i} = ${i};`);
const inserted = Array.from({ length: 80 }, (_, i) => `export const extra${i} = ${i};`);
const short = body.slice(0, 100);
const edit = (at: number[]) => body.map((l, i) => (at.includes(i) ? l.replace("=", "= 1 +") : l));
const focusedRange = () => page.locator(".hunk-head.is-focus .hh-range");

test.beforeAll(async () => {
  repo = initRepo();
  writeFileSync(join(repo, "a.ts"), body.join("\n") + "\n");
  writeFileSync(join(repo, "b.ts"), body.join("\n") + "\n");
  writeFileSync(join(repo, "c.ts"), body.join("\n") + "\n");
  writeFileSync(join(repo, "f.ts"), short.join("\n") + "\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  const a = edit([5, 150]);
  writeFileSync(join(repo, "a.ts"), [...a.slice(0, 60), ...inserted, ...a.slice(60)].join("\n") + "\n");
  const b = edit([150]);
  writeFileSync(join(repo, "b.ts"), [...b.slice(0, 10), ...inserted, ...b.slice(10)].join("\n") + "\n");
  writeFileSync(join(repo, "c.ts"), body.flatMap((l, i) => (i % 80 === 20 ? ["// same", l] : [l])).join("\n") + "\n");
  const f = [...short.slice(0, 10), ...inserted.slice(0, 30), ...short.slice(10)];
  writeFileSync(join(repo, "f.ts"), f.map((l) => (/v(49|79) /.test(l) ? l.replace("=", "= 1 +") : l)).join("\n") + "\n");

  ({ page } = await launch(repo));
  await expect(page.locator(".hunk-head").first()).toBeVisible();
});

test("undo goes back to the hunk, and leaving a file keeps your place in it", async () => {
  await idle();
  await page.keyboard.press("j");
  await page.keyboard.press("s");
  await expect(focusedRange()).toHaveText(/^−228,/);
  await idle();
  await page.keyboard.press("u");
  await expect(focusedRange()).toHaveText(/^−58,/);
  await idle();
  await page.keyboard.press("j");
  await expect(page.locator(".hunk-head.is-focus")).toBeInViewport();
  await page.keyboard.press("]");
  await expect(page.locator(".file.is-active .name")).toHaveText("b.ts");
  await page.keyboard.press("[");
  await expect(focusedRange()).toHaveText(/^−148,/);
  await expect(page.locator(".hunk-head.is-focus")).toBeInViewport();
  await page.keyboard.press("g");
  await page.keyboard.press("g");
});

test("staging the focused hunk moves focus to the next one, not the closer one above", async () => {
  await idle();
  await page.keyboard.press("j");
  await expect(focusedRange()).toHaveText(/^−58,/);
  await page.keyboard.press("s");
  await expect(page.locator(".stub")).toHaveCount(1);
  await expect(focusedRange()).toHaveText(/^−228,/);
  await expect(page.locator(".hunk-head.is-focus")).toBeInViewport();
});

test("staging the last hunk scrolls back up to the previous hunk's header", async () => {
  await page.locator(".file", { hasText: "b.ts" }).click();
  await expect(focusedRange()).toHaveText(/^−8,6  \+8,86/);
  await idle();
  await page.keyboard.press("j");
  await expect(focusedRange()).toHaveText(/^−148,/);
  await page.keyboard.press("s");
  await expect(focusedRange()).toHaveText(/^−8,/);
  await expect(page.locator(".hunk-head.is-focus")).toBeInViewport();
});

test("a press queued on a file's last hunk doesn't reach into a file not yet seen", async () => {
  await page.locator(".file", { hasText: "b.ts" }).click();
  await expect(focusedRange()).toHaveText(/^−8,/);
  await idle();
  const cBefore = git("diff", "--cached", "--", "c.ts");
  await page.keyboard.press("s");
  await page.keyboard.press("s");
  await expect.poll(() => git("diff", "--", "b.ts")).toBe("");
  await idle();
  await expect(page.locator(".toast.show button")).toBeVisible();
  expect(git("diff", "--cached", "--", "c.ts")).toBe(cBefore);
});

test("a press queued on the last hunk doesn't go back to one passed over", async () => {
  await page.locator(".file", { hasText: "a.ts" }).click();
  await page.keyboard.press("g");
  await page.keyboard.press("g");
  await expect(focusedRange()).toHaveText(/^−3,/);
  await idle();
  await page.keyboard.press("j");
  await expect(focusedRange()).toHaveText(/^−228,/);
  await page.keyboard.press("s");
  await page.keyboard.press("s");
  await expect(focusedRange()).toHaveText(/^−3,/);
  await idle();
  await expect(page.locator(".toast.show button")).toBeVisible();
  expect(git("diff", "--", "a.ts")).toContain("@@ -3,");
});

test("staging a hunk moves on even when an earlier hunk makes the same edit", async () => {
  await page.locator(".file", { hasText: "c.ts" }).click();
  await expect(focusedRange()).toHaveText(/^−18,6  \+18,7/);
  await idle();
  await page.keyboard.press("j");
  await expect(focusedRange()).toHaveText(/^−98,/);
  await page.keyboard.press("s");
  await expect(focusedRange()).toHaveText(/^−179,/);
  await expect(page.locator(".hunk-head.is-focus")).toBeInViewport();
});

const stageLast = async (left: number) => {
  await page.locator(".ln.b.add[data-line]").last().click();
  await page.keyboard.press("Escape");
  await idle();
  await page.keyboard.press("s");
  await expect(page.locator(".hunk-head")).toHaveCount(left);
};

test("only the newest stage's stub offers undo, and Show in Staged lands on its hunk though lines above moved", async () => {
  await page.locator(".file", { hasText: "f.ts" }).click();
  await expect(page.locator(".hunk-head")).toHaveCount(3);
  const undoButtons = page.locator(".stub").getByRole("button", { name: "Undo" });
  await stageLast(2);
  await expect(undoButtons).toHaveCount(1);
  await stageLast(1);
  await expect(page.locator(".stub")).toHaveCount(2);
  await expect(page.locator(".stub").first().getByRole("button", { name: "Undo" })).toBeVisible();
  await expect(undoButtons).toHaveCount(1);

  await page.locator(".ln.b.add[data-line]").first().click();
  await idle();
  await page.keyboard.press("s");
  await expect(undoButtons).toHaveCount(0);
  await idle();
  await page.keyboard.press("u");
  await expect.poll(() => git("diff", "--cached", "--numstat", "--", "f.ts")).toBe("2\t2\tf.ts\n");
  await expect(page.locator(".stub")).toHaveCount(2);

  await page.locator(".stub").first().getByRole("button", { name: "Show in Staged" }).click();
  await expect(page.locator(".picker-btn")).toHaveText("Staged");
  await expect(page.locator(".hunk-head")).toHaveCount(2);
  await expect(page.locator(".hunk-head").first()).toHaveClass(/is-focus/);
});

test("going back to a view shows the focused hunk even if the spot kept there doesn't", async () => {
  await page.locator(".file", { hasText: "b.ts" }).click();
  await expect(focusedRange()).toHaveText(/^−8,/);
  await idle();
  await page.keyboard.press("j");
  await expect(focusedRange()).toHaveText(/^−148,/);
  const focused = page.locator(".hunk-head.is-focus");
  await page.keyboard.press("3");
  await expect(page.locator(".picker-btn")).toContainText("All");
  await expect(focused).toBeInViewport();
  await page.locator(".diff-scroller").evaluate((el) => void (el.scrollTop = 0));
  await expect(focused).not.toBeInViewport();
  await page.keyboard.press("2");
  await expect(page.locator(".picker-btn")).toHaveText("Staged");
  await page.keyboard.press("3");
  await expect(focused).toBeInViewport();
});

test("coming back to a file edited meanwhile focuses the same hunk", async () => {
  await page.keyboard.press("1");
  await expect(page.locator(".picker-btn")).toHaveText("Unstaged");
  await page.locator(".file", { hasText: "c.ts" }).click();
  await expect(focusedRange()).toHaveText(/^−179,/);
  await page.locator(".file", { hasText: "a.ts" }).click();
  await expect(page.locator(".file.is-active .name")).toHaveText("a.ts");
  writeFileSync(join(repo, "c.ts"), readFileSync(join(repo, "c.ts"), "utf8").replace("v5 = 5", "v5 = 6"));
  await expect(page.locator(".file", { hasText: "c.ts" })).toContainText("+3");
  await page.locator(".file", { hasText: "c.ts" }).click();
  await expect(focusedRange()).toHaveText(/^−179,/);
});

test("opening a file while an undo runs stays on that file", async () => {
  await page.locator(".file", { hasText: "f.ts" }).click();
  await expect(page.locator(".file.is-active .name")).toHaveText("f.ts");
  await idle();
  await page.keyboard.press("s");
  await expect(page.locator(".toast.show")).toContainText("Staged");
  await idle();
  await page.locator(".file", { hasText: "c.ts" }).click();
  await expect(page.locator(".file.is-active .name")).toHaveText("c.ts");
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "u" }));
    document.querySelector<HTMLElement>('.file[data-path$="a.ts"]')!.click();
  });
  await expect(page.locator(".toast.show")).toContainText("Undid");
  await idle();
  await page.waitForTimeout(500);
  await expect(page.locator(".file.is-active .name")).toHaveText("a.ts");
});

test("coming back to the end of a file with wrapped lines lands at the end", async () => {
  const wrapped = Array.from({ length: 400 }, (_, i) => (i % 3 ? `line ${i}` : `line ${i} ${"wrapped ".repeat(75)}`));
  writeFileSync(join(repo, "long.txt"), wrapped.join("\n") + "\n");
  await page.locator(".file", { hasText: "long.txt" }).click();
  await expect(page.locator(".file.is-active .name")).toHaveText("long.txt");
  const scroller = page.locator(".diff-scroller");
  const last = page.getByText("line 398", { exact: true }).last();
  await expect(async () => {
    await scroller.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
    await expect(last).toBeInViewport({ timeout: 200 });
  }).toPass();
  await page.locator(".file", { hasText: "c.ts" }).click();
  await expect(page.locator(".file.is-active .name")).toHaveText("c.ts");
  await page.locator(".file", { hasText: "long.txt" }).click();
  await page.waitForTimeout(500);
  await expect(last).toBeInViewport();
});
