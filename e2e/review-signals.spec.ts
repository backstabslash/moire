import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { harness, lines, numbered, staged, writeCommitNotes, writeNotes } from "./harness";

const { commitAll, git, initRepo, launch, shots } = harness();
let repo: string;
let page: Page;

const { body } = numbered(40);
const edit = (at: Record<number, string>) => lines(body.map((l, i) => at[i] ?? l));
const write = (file: string, text: string) => writeFileSync(join(repo, file), text);
const save = (message: string) => {
  commitAll(message);
  return git("rev-parse", "HEAD").trim();
};
test.beforeAll(async () => {
  repo = initRepo();
  write("a.ts", lines(body));
  write("a.test.ts", 'it("adds", () => {\n  expect(add(1, 2)).toBe(3);\n  expect(add(2, 2)).toBe(4);\n});\n');
  save("base");
  git("checkout", "-q", "-b", "feature");
  write("a.ts", edit({ 4: "export const v4 = 40;" }));
  const one = save("first step");
  writeCommitNotes(repo, one, { summary: "First", chapters: [{ title: "Raises v4", text: "Raises it.", ranges: [{ path: "a.ts", lines: [5, 5] }] }] });
  write("a.ts", "// top\n// top\n" + edit({ 4: "export const v4 = 40;", 30: "export const v30 = 300;" }));
  write("a.test.ts", 'it("adds", () => {\n  expect(add(1, 2)).toBe(3);\n  expect(add(2, 2)).toBe(5);\n});\n');
  save("second step");
  write("a.ts", "// top\n// top\n" + edit({ 4: "export const v4 = 40;", 30: "export const v30 = 300;", 35: "export const v35\u00A0= 350;\t " }));
  write("fresh.ts", "export const fresh = 1;\n");
  ({ page } = await launch([repo, "main"]));
  await expect(page.locator(".picker-btn")).toHaveText("Branch vs branch");
});

test("a bare revision runs through to the working tree, and the branch picker can aim there", async () => {
  await expect(page.locator(".slot").last()).toContainText("Working tree");
  await expect(page.locator(".file")).toHaveCount(3);
  await expect(page.locator('.file[data-path="fresh.ts"]')).toBeVisible();
  await page.locator(".picker-btn").click();
  await page.getByRole("option", { name: /Branch vs branch/ }).click();
  await expect(page.getByLabel("Branch to review")).toHaveValue(":working-tree");
  await page.getByLabel("Branch to review").selectOption("feature");
  await page.locator(".branch-form .btn").click();
  await expect(page.locator(".slot").last()).toContainText("feature");
  await expect(page.locator(".file")).toHaveCount(2);
  await page.locator(".picker-btn").click();
  await page.getByRole("option", { name: /Branch vs branch/ }).click();
  await page.getByLabel("Branch to review").selectOption(":working-tree");
  await page.locator(".branch-form .btn").click();
  await expect(page.locator(".file")).toHaveCount(3);
});

test("notes from each commit are stitched together and placed on today's lines", async () => {
  const panel = page.locator(".notes-panel");
  await expect(panel.locator(".chapter-from")).toContainText(["first step"]);
  await expect(panel.locator(".chapter-title")).toHaveText(["Raises v4"]);
  await expect(panel.locator(".notes-cover")).toHaveText("Notes for 1 of 2 commits");
  await expect(panel.locator(".uncovered button > span:last-of-type")).toHaveText(["a.ts", "a.test.ts", "fresh.ts"]);
  await panel.locator(".chapter-head").click();
  await expect(panel.locator(".stop-where")).toHaveText("a.ts:7");
});

test("invisible characters and trailing whitespace are marked on changed lines, leaving the text as it is", async () => {
  await page.locator('.file[data-path="a.ts"]').click();
  const notice = page.locator(".invisible-notice");
  await expect(notice.locator(".invisible-kind")).toHaveText("NBSP");
  await expect(notice.locator("p")).toHaveText("1 invisible character on 1 line");
  await page.locator(".invisible-char").first().scrollIntoViewIfNeeded();
  const chip = page.locator(".invisible-char").first();
  await expect(chip).toHaveAttribute("data-name", "NBSP");
  await expect(page.locator(".ws-trail").first()).toBeVisible();
  expect(await page.locator(".cell.add .text").filter({ has: chip }).textContent()).toBe("export const v35\u00A0= 350;\t ");
  await shots("invisible");
  await notice.getByLabel("Close").click();
  await expect(notice).toHaveCount(0);
  await page.locator('.file[data-path="a.test.ts"]').click();
  await page.locator('.file[data-path="a.ts"]').click();
  await expect(page.locator(".invisible-char").first()).toBeVisible();
  await expect(notice).toHaveCount(0);
});

test("ignoring whitespace hides those changes, says so, and turns staging off", async () => {
  await page.keyboard.press("1");
  await expect(page.locator(".picker-btn")).toHaveText("Unstaged");
  write("a.test.ts", '  it("adds", () => {\n  expect(add(1, 2)).toBe(3);\n  expect(add(2, 2)).toBe(4);\n});\n');
  git("add", "a.test.ts");
  git("commit", "-qm", "put it back");
  write("a.test.ts", 'it("adds", () => {\n  expect(add(1, 2)).toBe(3);\n  expect(add(2, 2)).toBe(4);\n});\n');
  await expect(page.locator('.file[data-path="a.test.ts"]')).toBeVisible();
  await page.keyboard.press("w");
  await expect(page.locator(".tool-chip")).toHaveText("Whitespace hidden");
  writeNotes(repo, { chapters: [{ title: "Reindent", text: "", ranges: ["a.test.ts"] }] });
  const chapter = page.locator(".chapter", { hasText: "Reindent" });
  await expect(chapter).not.toHaveClass(/is-done/);
  await chapter.locator(".chapter-head").click();
  await expect(page.locator(".toast.show")).toContainText("Whitespace is hidden, so a.test.ts has nothing to show");
  await page.keyboard.press("1");
  await expect(page.locator('.file[data-path="a.test.ts"]')).toHaveCount(0);
  await page.locator('.file[data-path="a.ts"]').click();
  await expect(page.locator(".hh-stage")).toHaveCount(0);
  await page.keyboard.press("s");
  await expect(page.locator(".toast.show")).toContainText("Turn off Ignore whitespace");
  git("add", "a.ts");
  await page.keyboard.press("2");
  await expect(page.locator(".commit-blocked")).toContainText("Show whitespace changes");
  await page.getByLabel("Commit message").fill("nope");
  await expect(page.locator(".commit-box .btn")).toBeDisabled();
  await page.locator(".commit-box .stage-progress-line button").click();
  await expect(page.locator(".toast.show")).toContainText("Turn off Ignore whitespace");
  expect(staged(repo)).toContain("a.ts");
  git("reset", "-q");
  await page.keyboard.press("1");
  await page.locator(".tool-chip").click();
  await expect(page.locator(".tool-chip")).toHaveCount(0);
  await expect(page.locator('.file[data-path="a.test.ts"]')).toBeVisible();
});
