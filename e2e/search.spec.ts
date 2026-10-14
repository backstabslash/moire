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

const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args]);
const body = Array.from({ length: 60 }, (_, i) => `export const v${i} = ${i};`);
const shot = (name: string) => process.env.MOIRE_SHOTS && page.screenshot({ path: join(process.env.MOIRE_SHOTS, `${name}.png`) });

test.beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "moire-e2e-repo-"));
  userData = mkdtempSync(join(tmpdir(), "moire-e2e-data-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "e2e@example.com");
  git("config", "user.name", "e2e");
  writeFileSync(join(repo, "a.ts"), body.join("\n") + "\n");
  writeFileSync(join(repo, "b.ts"), body.join("\n") + "\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  writeFileSync(join(repo, "a.ts"), body.map((l, i) => (i === 3 ? l.replace("= 3", "= 30") : l)).join("\n") + "\n");
  writeFileSync(join(repo, "b.ts"), body.map((l, i) => (i === 25 ? l.replace("= 25", "= 99") : l)).join("\n") + "\n");

  app = await electron.launch({ args: [resolve("."), `--user-data-dir=${userData}`, repo], env: { ...process.env, MOIRE_HIDDEN: "1" } });
  page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  await expect(page.locator(".file")).toHaveCount(2);
});

test.afterAll(async () => {
  await app?.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(userData, { recursive: true, force: true });
});

test.afterEach(() => {
  expect(errors).toEqual([]);
});

test("search finds hits in folded context and in other files", async () => {
  await page.keyboard.press("Control+f");
  const input = page.getByRole("searchbox").or(page.getByLabel("Search"));
  await expect(input).toBeFocused();
  await input.fill("v25 ");
  await expect(page.locator(".search-status")).toHaveText("1 of 3");
  // the hit in a.ts sits in folded context, so its fold opens
  // an unchanged line shows on both sides in split view, so the current hit does too
  await expect(page.locator("mark.hit.is-current")).toHaveText(["v25 ", "v25 "]);
  await expect(page.locator(".file.is-active .name")).toHaveText("a.ts");
  await expect(page.locator(".file", { hasText: "b.ts" }).locator(".hit-count")).toHaveText("2");
  await shot("search");

  await input.press("Enter");
  await expect(page.locator(".search-status")).toHaveText("2 of 3");
  await expect(page.locator(".file.is-active .name")).toHaveText("b.ts");
  await expect(page.locator(".cell.a mark.hit.is-current")).toHaveText("v25 ");
  await input.press("Shift+Enter");
  await expect(page.locator(".file.is-active .name")).toHaveText("a.ts");

  await page.getByTitle("Search side B only").click();
  await expect(page.locator(".search-status")).toHaveText(/of 2$/);
  await page.getByTitle("Regular expression").click();
  await input.fill("v2[0-9] = 99");
  await expect(page.locator(".search-status")).toHaveText("1 of 1");
  await expect(page.locator(".file.is-active .name")).toHaveText("b.ts");
  await input.fill("(");
  await expect(page.locator(".search-status")).toHaveText("Invalid pattern");

  await input.press("Escape");
  await expect(page.locator(".search")).toHaveCount(0);
  await expect(page.locator("mark.hit")).toHaveCount(0);
  await page.keyboard.press("/");
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("(");
});
