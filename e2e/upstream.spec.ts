import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { configure, gitIn, harness } from "./harness";

const { git, initRepo, launch, shot, tmp } = harness();
let dir: string;
let repo: string;
let other: string;
let page: Page;

const run = (cwd: string, ...args: string[]) => gitIn(cwd)(...args);
const commit = (cwd: string, name: string) => {
  writeFileSync(join(cwd, name), `${name}\n`);
  run(cwd, "add", name);
  run(cwd, "commit", "-qm", `add ${name}`);
};
const sync = () => page.locator(".side-head .sync");

test.beforeAll(async () => {
  dir = tmp("upstream");
  other = join(dir, "other");
  run(dir, "init", "-q", "--bare", "-b", "main", "remote.git");
  repo = initRepo(join(dir, "repo"));
  commit(repo, "a.txt");
  git("remote", "add", "origin", join(dir, "remote.git"));
  writeFileSync(join(repo, "a.txt"), "edited\n");

  ({ page } = await launch(repo));
  await expect(page.locator(".file")).toHaveCount(1);
});

test("shows nothing without an upstream, then commits to push as of the last fetch", async () => {
  await expect(sync()).toHaveCount(0);
  git("push", "-q", "-u", "origin", "main");
  commit(repo, "b.txt");
  commit(repo, "c.txt");
  await expect(sync()).toHaveText("↑2");
  await expect(sync().getByRole("button")).toHaveAttribute("data-tip", /2 commits to push[^]*Never fetched/);
  await shot("upstream-ahead");

  await sync().getByRole("button", { name: "↑2" }).click();
  await expect(page.locator(".picker-btn")).toHaveText("Branch vs branch");
  await expect(page.locator(".slot").first()).toContainText("origin/main");
  await expect(page.locator(".file .name")).toHaveText(["b.txt", "c.txt"]);
  await page.keyboard.press("1");
});

test("5 goes back to the branches last compared, and pressed again offers them for a change", async () => {
  await page.keyboard.press("5");
  await expect(page.locator(".picker-btn")).toHaveText("Branch vs branch");
  await expect(page.locator(".slot").first()).toContainText("origin/main");
  await page.keyboard.press("5");
  await expect(page.getByLabel("Base branch")).toHaveValue("origin/main");
  await page.keyboard.press("Escape");
  await expect(page.locator(".picker-pop")).toHaveCount(0);
  await page.keyboard.press("1");
  await expect(page.locator(".picker-btn")).toHaveText("Unstaged");
});

test("a push clears the count, and a fetch shows what's new upstream", async () => {
  git("push", "-q");
  await expect(sync()).toHaveCount(0);

  run(dir, "clone", "-q", join(dir, "remote.git"), "other");
  configure(other);
  commit(other, "d.txt");
  run(other, "push", "-q");

  git("fetch", "-q");
  await expect(sync()).toHaveText("↓1");
  await expect(sync().getByRole("button")).toHaveAttribute("data-tip", /last fetch/);
});
