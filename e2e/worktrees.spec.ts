import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, type ElectronApplication, expect, type Page, test } from "@playwright/test";

let dir: string;
let repo: string;
let agent: string;
let userData: string;
let app: ElectronApplication;
let page: Page;
const errors: string[] = [];

const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
const shot = (name: string) => process.env.MOIRE_SHOTS && page.screenshot({ path: join(process.env.MOIRE_SHOTS, `${name}.png`) });

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "moire-e2e-worktrees-"));
  userData = mkdtempSync(join(tmpdir(), "moire-e2e-data-"));
  repo = join(dir, "repo");
  agent = join(dir, "agent");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git("config", "user.email", "e2e@example.com");
  git("config", "user.name", "e2e");
  writeFileSync(join(repo, "a.txt"), "a\n");
  git("add", "a.txt");
  git("commit", "-qm", "init");
  git("worktree", "add", "-q", "-b", "agent", agent);
  writeFileSync(join(agent, "a.txt"), "changed by the agent\n");
  writeFileSync(join(agent, "b.txt"), "new\n");
  writeFileSync(join(repo, "a.txt"), "edited\n");

  app = await electron.launch({ args: [resolve("."), `--user-data-dir=${userData}`, repo], env: { ...process.env, MOIRE_HIDDEN: "1" } });
  page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  await expect(page.locator(".file")).toHaveCount(1);
});

test.afterAll(async () => {
  await app?.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(userData, { recursive: true, force: true });
});

test.afterEach(() => {
  expect(errors).toEqual([]);
});

test("the repo picker lists the other worktrees and opens one", async () => {
  await page.locator("body").press("o");
  const option = page.locator(".repo-pop [role=option]").first();
  await expect(option).toContainText("agent");
  await expect(option.locator(".repo-tree")).toHaveText("agent · 2 changed");
  await shot("worktrees");
  await option.click();
  await expect(page.locator(".file")).toHaveCount(2);
});
