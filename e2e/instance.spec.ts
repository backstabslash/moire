import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { _electron as electron, type ElectronApplication, expect, test } from "@playwright/test";

let one: string;
let two: string;
let plain: string;
let userData: string;
let app: ElectronApplication;

function makeRepo(dir: string) {
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args]);
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "a\n");
}

function launchAgain(...args: string[]): Promise<number | null> {
  const child = spawn(app.process().spawnfile, [resolve("."), `--user-data-dir=${userData}`, ...args], {
    env: { ...process.env, MOIRE_HIDDEN: "1" },
    stdio: "ignore",
  });
  return new Promise((done) => child.on("exit", done));
}

test.beforeAll(async () => {
  [one, two, plain, userData] = ["one", "two", "plain", "data"].map((n) => mkdtempSync(join(tmpdir(), `moire-e2e-${n}-`)));
  makeRepo(one);
  makeRepo(two);
  app = await electron.launch({ args: [resolve("."), `--user-data-dir=${userData}`, one], env: { ...process.env, MOIRE_HIDDEN: "1", MOIRE_REPO: "" } });
  await expect((await app.firstWindow()).locator(".repo")).toContainText(basename(one));
});

test.afterAll(async () => {
  await app?.close();
  for (const dir of [one, two, plain, userData]) rmSync(dir, { recursive: true, force: true });
});

test("a second launch opens its repo in a new window of the running app", async () => {
  const opened = app.waitForEvent("window");
  expect(await launchAgain(two)).toBe(0);
  await expect((await opened).locator(".repo")).toContainText(basename(two));
  expect(app.windows()).toHaveLength(2);
});

test("launching an open repo again reuses its window", async () => {
  expect(await launchAgain(one)).toBe(0);
  await new Promise((r) => setTimeout(r, 500));
  expect(app.windows()).toHaveLength(2);
});

test("a path that isn't a repo says so instead of opening another one", async () => {
  const opened = app.waitForEvent("window");
  expect(await launchAgain(plain)).toBe(0);
  await expect((await opened).locator(".empty-state")).toContainText(`${plain} isn't a git repository`);
});

test("a launch without a repo, like a panel's Open New Window, opens a window with the picker", async () => {
  const opened = app.waitForEvent("window");
  expect(await launchAgain()).toBe(0);
  await expect((await opened).getByRole("heading", { name: "Open a repository." })).toBeVisible();
});
