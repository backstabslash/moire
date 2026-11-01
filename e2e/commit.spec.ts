import { chmodSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { harness, lines, numbered } from "./harness";

const { clipboard, commitAll, git, idle, initRepo, launch, shot, shots } = harness();
let repo: string;
let page: Page;

const { body } = numbered(60);
const write = (list: string[]) => writeFileSync(join(repo, "a.ts"), lines(list));

test.beforeAll(async () => {
  repo = initRepo();
  git("config", "user.name", "Ada Lovelace");
  write(body);
  writeFileSync(join(repo, "b.ts"), "export const b = 1;\n");
  commitAll("init");
  git("tag", "v1");
  git("commit", "-q", "--allow-empty", "-m", "agent work", "-m", "Co-authored-by: Claude <noreply@anthropic.com>");
  write(body.map((l, i) => (i === 30 ? l.replace("= 30", "= 300") : l)));
  writeFileSync(join(repo, "b.ts"), "export const b = 2;\n");
  ({ page } = await launch(repo));
  await expect(page.locator(".file")).toHaveCount(2);
});

test("the commit list reads whole refs, with relative dates, avatars and agent marks", async () => {
  await page.locator(".picker-btn").click();
  await page.getByRole("option", { name: /^Commit/ }).click();
  const rows = page.locator(".commit-list [role=option]");
  await expect(rows).toHaveCount(2);
  const first = rows.first();
  await expect(first.locator(".avatar")).toHaveText("AL");
  await expect(first.locator(".ref-agent")).toHaveText("Claude");
  await expect(first.locator(".ref-current")).toHaveText("main");
  await expect(rows.nth(1).locator(".ref-tag")).toHaveText("v1");
  await expect(first.locator("small")).toContainText("just now");
  for (const ref of await first.locator(".ref").all()) {
    expect(await ref.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
  await shot("commit-list");
  await first.click();
  await expect(page.locator(".commit-head .avatar")).toHaveText("AL");
  await expect(page.locator(".commit-head .ref-agent")).toHaveText("Claude");
  await page.keyboard.press("1");
});

test("with everything staged, Unstaged says so and leads on to the commit", async () => {
  git("add", "-A");
  await expect(page.locator(".empty-state h2")).toHaveText("All 2 changes are staged.");
  await expect(page.locator(".sidebar")).toBeVisible();
  await expect(page.locator(".stage-progress")).toContainText("All staged");
  await shot("all-staged");

  await page.locator(".empty-actions").getByRole("button", { name: "Commit" }).click();
  await expect(page.locator(".picker-btn")).toHaveText("Staged");
  const box = page.getByLabel("Commit message");
  await expect(box).toBeFocused();
  await box.fill("Make v30 bigger\n\nAnd b too.");
  await box.press("Control+Enter");

  await expect(page.locator(".empty-state h2")).toHaveText("Committed.");
  await expect(page.locator(".empty-state p")).toHaveText(/^[0-9a-f]{7,} Make v30 bigger$/);
  expect(git("log", "-1", "--format=%B").trim()).toBe("Make v30 bigger\n\nAnd b too.");
  await expect(page.locator(".sidebar")).toBeVisible();
  await shot("committed");

  await page.getByRole("button", { name: "Show commit" }).click();
  await expect(page.locator(".picker-btn")).toHaveText("Commit");
  await expect(page.locator(".commit-head")).toContainText("Make v30 bigger");
  await expect(page.locator(".commit-head")).toContainText("Ada Lovelace");
  await expect(page.locator(".commit-body")).toHaveCount(0);
  await page.locator(".commit-subject").click();
  await expect(page.locator(".commit-body")).toHaveText("And b too.");
  await shot("commit-head");
});

test("a failed commit shows the hook's whole output until dismissed", async () => {
  await page.keyboard.press("1");
  write(body.map((l, i) => (i === 3 ? l.replace("=", "= 1 +") : l)));
  await page.locator(".file", { hasText: "a.ts" }).click();
  await idle();
  await page.getByRole("button", { name: "Stage file" }).click();
  await expect(page.locator(".toast.show")).toContainText("Staged a.ts");
  const hook = join(repo, ".git", "hooks", "pre-commit");
  writeFileSync(hook, "#!/bin/sh\necho 'a.ts' >&2\necho '  4:1  error  Unexpected 1 + 3  no-implicit-math' >&2\necho '1 problem' >&2\nexit 1\n");
  chmodSync(hook, 0o755);
  await page.keyboard.press("2");
  await idle();
  const message = page.locator(".commit-box textarea");
  await message.fill("Change a");
  await page.clock.install();
  await message.press("Control+Enter");
  const panel = page.locator(".commit-error");
  await expect(panel.locator("pre")).toHaveText("a.ts\n  4:1  error  Unexpected 1 + 3  no-implicit-math\n1 problem");
  await message.blur();
  await page.clock.fastForward(5500);
  await expect(panel).toBeVisible();
  await shots("commit-error");
  await panel.getByRole("button", { name: "Copy" }).click();
  expect(await clipboard()).toBe("a.ts\n  4:1  error  Unexpected 1 + 3  no-implicit-math\n1 problem");
  await panel.getByRole("button", { name: "Dismiss" }).click();
  await expect(panel).toHaveCount(0);
  await expect(message).toHaveValue("Change a");

  rmSync(hook);
  await page.keyboard.press("1");
  await idle();
  await page.keyboard.press("2");
  await expect(message).toHaveValue("Change a");
  await message.press("Control+Enter");
  await expect(page.locator(".toast.show")).toContainText("Committed");
  expect(existsSync(hook)).toBe(false);
});
