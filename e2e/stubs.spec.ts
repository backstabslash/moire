import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, type ElectronApplication, expect, type Page, test } from "@playwright/test";

let repo: string;
let userData: string;
let app: ElectronApplication;
let page: Page;
const errors: string[] = [];

const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
const body = Array.from({ length: 100 }, (_, i) => `export const v${i} = ${i};`);
const inserted = Array.from({ length: 30 }, (_, i) => `export const extra${i} = ${i};`);
const edited = [...body.slice(0, 10), ...inserted, ...body.slice(10)].map((l) => (/v(49|79) /.test(l) ? l.replace("=", "= 1 +") : l));
const idle = () => expect(page.locator(".app")).toHaveAttribute("aria-busy", "false");

test.beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "moire-e2e-repo-"));
  userData = mkdtempSync(join(tmpdir(), "moire-e2e-data-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "e2e@example.com");
  git("config", "user.name", "e2e");
  writeFileSync(join(repo, "f.ts"), body.join("\n") + "\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  writeFileSync(join(repo, "f.ts"), edited.join("\n") + "\n");

  app = await electron.launch({ args: [resolve("."), `--user-data-dir=${userData}`, repo], env: { ...process.env, MOIRE_HIDDEN: "1" } });
  page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  await expect(page.locator(".hunk-head")).toHaveCount(3);
});

test.afterAll(async () => {
  await app?.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(userData, { recursive: true, force: true });
});

test.afterEach(() => {
  expect(errors).toEqual([]);
});

const stageLast = async (left: number) => {
  await page.locator(".ln.b.add[data-line]").last().click();
  await page.keyboard.press("Escape");
  await idle();
  await page.keyboard.press("s");
  await expect(page.locator(".hunk-head")).toHaveCount(left);
};

test("only the newest stage's stub offers undo, and Show in Staged lands on its hunk though lines above moved", async () => {
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
  await expect.poll(() => git("diff", "--cached", "--numstat")).toBe("2\t2\tf.ts\n");
  await expect(page.locator(".stub")).toHaveCount(2);

  await page.locator(".stub").first().getByRole("button", { name: "Show in Staged" }).click();
  await expect(page.locator(".picker-btn")).toHaveText("Staged");
  await expect(page.locator(".hunk-head")).toHaveCount(2);
  await expect(page.locator(".hunk-head").first()).toHaveClass(/is-focus/);
});
