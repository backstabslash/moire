import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { _electron as electron, type ElectronApplication, expect, type Page, test } from "@playwright/test";

let repo: string;
let other: string;
let userData: string;
let bin: string;
let app: ElectronApplication;
let page: Page;
const errors: string[] = [];

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
const body = Array.from({ length: 40 }, (_, i) => `export const v${i} = ${i};`);

function makeRepo(dir: string) {
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "e2e@example.com");
  git(dir, "config", "user.name", "e2e");
}

test.beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "moire-e2e-repo-"));
  other = mkdtempSync(join(tmpdir(), "moire-e2e-other-"));
  userData = mkdtempSync(join(tmpdir(), "moire-e2e-data-"));
  bin = mkdtempSync(join(tmpdir(), "moire-e2e-bin-"));
  makeRepo(repo);
  makeRepo(other);
  writeFileSync(join(other, "x.ts"), "x\n");
  git(other, "add", "-A");
  git(other, "commit", "-qm", "init");

  writeFileSync(join(repo, "a.ts"), body.join("\n") + "\n");
  writeFileSync(join(repo, "ws.ts"), "if (a) {\n  b();\n}\n");
  writeFileSync(join(repo, "pnpm-lock.yaml"), "lock: 1\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  writeFileSync(join(repo, "a.ts"), body.map((l, i) => (i === 3 ? l.replace("= 3", "= 30") : l)).join("\n") + "\n");
  writeFileSync(join(repo, "ws.ts"), "if (a) {\n    b();\n}\n");
  writeFileSync(join(repo, "pnpm-lock.yaml"), "lock: 2\n");

  // remembered repos, and a fake editor that records what it was asked to open
  writeFileSync(join(userData, "state.json"), JSON.stringify({ lastRepo: repo, recent: [repo, other] }));
  writeFileSync(join(bin, "fake-editor"), `#!/bin/sh\necho "$@" > "${join(bin, "opened")}"\n`);
  chmodSync(join(bin, "fake-editor"), 0o755);

  app = await electron.launch({
    args: [resolve("."), `--user-data-dir=${userData}`, repo],
    env: { ...process.env, MOIRE_HIDDEN: "1", MOIRE_EDITOR: `${join(bin, "fake-editor")} {file}:{line}` },
  });
  page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  await expect(page.locator(".file")).toHaveCount(3);
});

test.afterAll(async () => {
  await app?.close();
  for (const dir of [repo, other, userData, bin]) rmSync(dir, { recursive: true, force: true });
});

test.afterEach(() => {
  expect(errors).toEqual([]);
});

test("lockfiles and whitespace-only hunks fold away until asked", async () => {
  await page.locator(".file", { hasText: "pnpm-lock.yaml" }).click();
  await expect(page.locator(".note")).toContainText("Lockfile, 2 changed lines, folded away.");
  await page.getByRole("button", { name: "Show changes" }).click();
  await expect(page.locator(".hunk-head")).toHaveCount(1);

  await page.locator(".file", { hasText: "ws.ts" }).click();
  await expect(page.locator(".fold", { hasText: "Whitespace-only changes" })).toBeVisible();
  await page.locator(".fold", { hasText: "Whitespace-only changes" }).click();
  await expect(page.locator(".cell.add")).toHaveText("    b();");
});

test("the file filter narrows the list and what [ ] walk", async () => {
  await page.keyboard.press("p");
  await page.keyboard.type("lck");
  await expect(page.locator(".file")).toHaveCount(1);
  await expect(page.locator(".side-head .count")).toHaveText("1 of 3");
  await page.keyboard.press("Enter");
  await expect(page.locator(".file.is-active .name")).toHaveText("pnpm-lock.yaml");
  await page.keyboard.press("]");
  await expect(page.locator(".file.is-active .name")).toHaveText("pnpm-lock.yaml");
  await page.locator(".file-filter").focus();
  await page.keyboard.press("Escape");
  await expect(page.locator(".file")).toHaveCount(3);
});

test("e opens the focused hunk's line in the editor", async () => {
  await page.locator(".file", { hasText: "a.ts" }).click();
  await expect(page.locator(".hunk-head")).toHaveCount(1);
  await page.keyboard.press("e");
  await expect(page.locator(".toast.show")).toContainText("Opened in fake-editor");
  await expect.poll(() => readFileSync(join(bin, "opened"), "utf8").trim()).toBe(`${join(repo, "a.ts")}:4`);
});

test("commit from the staged view", async () => {
  await page.getByRole("button", { name: "Stage file" }).click();
  await expect(page.locator(".app")).toHaveAttribute("aria-busy", "false");
  await page.keyboard.press("2");
  const box = page.getByLabel("Commit message");
  await box.fill("Change v3\n\nFrom the app");
  await box.press("Control+Enter");
  await expect(page.locator(".toast.show")).toContainText(/Committed [0-9a-f]{7,} Change v3/);
  expect(git(repo, "log", "-1", "--format=%B").trim()).toBe("Change v3\n\nFrom the app");
  await expect(page.getByRole("heading", { name: "Nothing staged." })).toBeVisible();
});

test("o lists recent repos and opens one", async () => {
  await page.keyboard.press("o");
  const option = page.locator(".repo-pop [role=option]", { hasText: basename(other) });
  await expect(option).toBeVisible();
  await expect(page.locator(".repo-pop [role=option]").last()).toContainText("Browse…");
  await page.keyboard.press("Enter");
  await expect(page.locator(".repo-pop")).toHaveCount(0);
  await expect.poll(() => JSON.parse(readFileSync(join(userData, "state.json"), "utf8")).recent[0]).toBe(other);
});
