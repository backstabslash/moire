import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { harness } from "./harness";

const { git, initRepo, launch, launchAgain, tmp } = harness();
let repo: string;
let bin: string;
let app: ElectronApplication;
let page: Page;

const commit = (file: string, message: string) => {
  writeFileSync(join(repo, file), `${message}\n`);
  git("add", "-A");
  git("commit", "-qm", message);
};

test.beforeAll(async () => {
  repo = initRepo();
  bin = tmp("bin");
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/sh\nfor _ in $(seq 200); do [ -e ${join(bin, "finish")} ] && break; sleep 0.05; done\ntouch ${join(bin, "ran")}\necho 'no pull requests found' >&2\nexit 1\n`,
  );
  chmodSync(join(bin, "gh"), 0o755);
  commit("base.txt", "base");
  git("checkout", "-q", "-b", "feature");
  commit("one.txt", "one");
  commit("two.txt", "two");
  ({ app, page } = await launch([repo, "main..feature"], { env: { PATH: `${bin}:${process.env.PATH}` } }));
});

test("a range on the command line opens straight onto that comparison", async () => {
  await expect(page.locator(".picker-btn")).toHaveText("Branch vs branch");
  await expect(page.locator(".slot").first()).toContainText("main (merge base");
  await expect(page.locator(".slot").last()).toContainText("feature");
  await expect(page.locator(".file")).toHaveCount(2);
});

test("a second launch reuses the window and moves it to the new comparison", async () => {
  expect(await launchAgain(repo, "HEAD~1")).toBe(0);
  await expect(page.locator(".slot").first()).toContainText("HEAD~1");
  await expect(page.locator(".file")).toHaveCount(1);
  expect(app.windows()).toHaveLength(1);
});

test("a comparison alone uses the folder it was run from", async () => {
  expect(await launchAgain("main..")).toBe(0);
  await expect(page.locator(".file")).toHaveCount(2);
  expect(app.windows()).toHaveLength(1);
});

test("a revision that doesn't exist says so and leaves the view alone", async () => {
  expect(await launchAgain(repo, "nope..main")).toBe(0);
  await expect(page.locator(".toast.show")).toContainText("Unknown revision: nope");
  await expect(page.locator(".file")).toHaveCount(2);
});

test("a newer comparison wins over a slower one still running", async () => {
  expect(await launchAgain(repo, "pr", "7")).toBe(0);
  expect(await launchAgain(repo, "HEAD~1")).toBe(0);
  await expect(page.locator(".slot").first()).toContainText("HEAD~1");
  writeFileSync(join(bin, "finish"), "");
  await expect.poll(() => existsSync(join(bin, "ran"))).toBe(true);
  await page.waitForTimeout(200);
  await expect(page.locator(".toast.show")).not.toContainText("no pull requests found");
});

test("running a pull request again shows what was pushed since", async () => {
  const gh = '{"baseRefName":"main","commits":[],"headRefOid":"x","mergeCommit":null,"state":"OPEN","url":"https://github.com/owner/repo/pull/9"}';
  writeFileSync(join(bin, "gh"), `#!/bin/sh\nsleep 0.5\necho '${gh}'\n`);
  git("config", `url.${repo}.insteadOf`, "https://github.com/owner/repo.git");
  git("update-ref", "refs/pull/9/head", "feature~1");
  expect(await launchAgain(repo, "pr", "9")).toBe(0);
  await expect(page.locator(".slot").last()).toContainText("moire/pr/9/head");
  await expect(page.locator(".file")).toHaveCount(1);

  git("update-ref", "refs/pull/9/head", "feature");
  expect(await launchAgain(repo, "pr", "9")).toBe(0);
  await expect(page.locator(".file")).toHaveCount(2);
});

test("a launch that failed leaves no comparison for the next repo", async () => {
  const opened = app.waitForEvent("window");
  expect(await launchAgain(join(repo, "missing"), "pr", "5")).toBe(0);
  const failed = await opened;
  await expect(failed.locator("body")).toContainText("missing");
  type Api = { moire: { takeCompare(): Promise<string[] | null> } };
  expect(await failed.evaluate(() => (window as unknown as Api).moire.takeCompare())).toBeNull();
  await failed.close();
});
