import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { commitAllIn, harness } from "./harness";

const { git, initRepo, launch, shot, tmp, userData } = harness();
let dir: string;
let repo: string;
let agent: string;
let other: string;
let page: Page;

test.beforeAll(async () => {
  dir = tmp("worktrees");
  repo = initRepo(join(dir, "repo"));
  agent = join(dir, "agent");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git("add", "a.txt");
  git("commit", "-qm", "init");
  git("worktree", "add", "-q", "-b", "agent", agent);
  writeFileSync(join(agent, "a.txt"), "changed by the agent\n");
  writeFileSync(join(agent, "b.txt"), "new\n");
  writeFileSync(join(repo, "a.txt"), "edited\n");

  other = initRepo();
  writeFileSync(join(other, "x.ts"), "x\n");
  commitAllIn(other)("init");
  writeFileSync(join(userData(), "state.json"), JSON.stringify({ lastRepo: repo, recent: [repo, other] }));

  ({ page } = await launch(repo));
  await expect(page.locator(".file")).toHaveCount(1);
});

test("the repo picker lists the other worktrees and opens one", async () => {
  await page.locator("body").press("o");
  const option = page.locator(".repo-pop [role=option]").first();
  await expect(option).toContainText("agent");
  await expect(option.locator(".repo-tree")).toHaveText("agent, 2 changed");
  await shot("worktrees");
  await option.click();
  await expect(page.locator(".file")).toHaveCount(2);
});

test("o lists recent repos and opens one", async () => {
  await page.keyboard.press("o");
  const option = page.locator(".repo-pop [role=option]", { hasText: basename(other) });
  await expect(option).toBeVisible();
  await expect(page.locator(".repo-pop [role=option]").last()).toContainText("Browse…");
  await page.keyboard.type(basename(other));
  await page.keyboard.press("Enter");
  await expect(page.locator(".repo-pop")).toHaveCount(0);
  await expect.poll(() => JSON.parse(readFileSync(join(userData(), "state.json"), "utf8")).recent[0]).toBe(other);
});
