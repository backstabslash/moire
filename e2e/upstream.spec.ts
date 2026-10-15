import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, type ElectronApplication, expect, type Page, test } from "@playwright/test";

let dir: string;
let repo: string;
let other: string;
let userData: string;
let app: ElectronApplication;
let page: Page;
const errors: string[] = [];

const run = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
const git = (...args: string[]) => run(repo, ...args);
const shot = (name: string) => process.env.MOIRE_SHOTS && page.screenshot({ path: join(process.env.MOIRE_SHOTS, `${name}.png`) });
const commit = (cwd: string, name: string) => {
  writeFileSync(join(cwd, name), `${name}\n`);
  run(cwd, "add", name);
  run(cwd, "commit", "-qm", `add ${name}`);
};
const sync = () => page.locator(".side-head .sync");

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "moire-e2e-upstream-"));
  userData = mkdtempSync(join(tmpdir(), "moire-e2e-data-"));
  repo = join(dir, "repo");
  other = join(dir, "other");
  run(dir, "init", "-q", "--bare", "-b", "main", "remote.git");
  run(dir, "init", "-q", "-b", "main", "repo");
  git("config", "user.email", "e2e@example.com");
  git("config", "user.name", "e2e");
  commit(repo, "a.txt");
  git("remote", "add", "origin", join(dir, "remote.git"));
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

test("shows nothing without an upstream, then commits to push as of the last fetch", async () => {
  await expect(sync()).toHaveCount(0);
  git("push", "-q", "-u", "origin", "main");
  commit(repo, "b.txt");
  commit(repo, "c.txt");
  await expect(sync()).toHaveText("↑2");
  await expect(sync().getByRole("button")).toHaveAttribute("title", /^2 commits to push to origin\/main\. .*\nNever fetched\.$/);
  await shot("upstream-ahead");

  await sync().getByRole("button", { name: "↑2" }).click();
  await expect(page.locator(".picker-btn")).toHaveText("Branch vs branch");
  await expect(page.locator(".slot").first()).toContainText("origin/main");
  await expect(page.locator(".file .name")).toHaveText(["b.txt", "c.txt"]);
  await page.keyboard.press("1");
});

test("a push clears the count, and a fetch shows what's new upstream", async () => {
  git("push", "-q");
  await expect(sync()).toHaveCount(0);

  run(dir, "clone", "-q", join(dir, "remote.git"), "other");
  run(other, "config", "user.email", "e2e@example.com");
  run(other, "config", "user.name", "e2e");
  commit(other, "d.txt");
  run(other, "push", "-q");
  await page.waitForTimeout(300);
  await expect(sync()).toHaveCount(0);

  git("fetch", "-q");
  await expect(sync()).toHaveText("↓1");
  await expect(sync().getByRole("button")).toHaveAttribute("title", /\nAs of the last fetch, (just now|\d+ seconds? ago)\.$/);
});
