import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, type ElectronApplication, expect, type Page, test } from "@playwright/test";

let repo: string;
let userData: string;
let app: ElectronApplication;
let page: Page;
const errors: string[] = [];

const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
const body = Array.from({ length: 40 }, (_, i) => `export const v${i} = ${i};`);
const edited = body.map((l, i) => (i === 3 || i === 33 ? l.replace("=", "= 1 +") : l)).join("\n") + "\n";
const shot = (name: string) => process.env.MOIRE_SHOTS && page.screenshot({ path: join(process.env.MOIRE_SHOTS, `${name}.png`) });

test.beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "moire-e2e-repo-"));
  userData = mkdtempSync(join(tmpdir(), "moire-e2e-data-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "e2e@example.com");
  git("config", "user.name", "e2e");
  writeFileSync(join(repo, "a.ts"), body.join("\n") + "\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  writeFileSync(join(repo, "a.ts"), edited);
  writeFileSync(join(repo, "new.ts"), "export const fresh = true;\n");

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

test("selecting one line stages only that line, and u undoes it", async () => {
  const added = page.locator(".ln.b.add[data-line]").first();
  await added.click();
  await expect(page.locator(".ln.sel")).toHaveCount(1);
  await expect(page.locator(".hunk-head.has-sel .hh-stage")).toHaveText(/^Stage 1 line/);
  await shot("selected");
  await page.keyboard.press("s");
  await expect(page.locator(".toast.show")).toContainText("Staged 1 line in a.ts");
  await expect(page.locator(".ln.sel")).toHaveCount(0);
  expect(git("show", ":a.ts")).toContain("export const v3 = 3;\nexport const v3 = 1 + 3;\n");
  await page.keyboard.press("u");
  await expect(page.locator(".toast.show")).toContainText("Undid: Staged 1 line in a.ts");
  await expect.poll(() => git("diff", "--cached")).toBe("");
});

test("x discards the focused hunk and u brings it back", async () => {
  await expect(page.locator(".app")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator(".hunk-head")).toHaveCount(2);
  await page.keyboard.press("x");
  await expect(page.locator(".toast.show")).toContainText("Discarded 2 lines in a.ts");
  await expect(page.locator(".hunk-head")).toHaveCount(1);
  expect(readFileSync(join(repo, "a.ts"), "utf8")).toContain("export const v3 = 3;");
  await page.keyboard.press("u");
  await expect(page.locator(".hunk-head")).toHaveCount(2);
  expect(readFileSync(join(repo, "a.ts"), "utf8")).toBe(edited);
});

test("staging a whole file moves on to the next one, and the All view marks what's staged", async () => {
  await page.locator(".hunk-head").first().hover();
  await page.locator(".hunk-head").first().locator(".hh-stage").click();
  await expect(page.locator(".hunk-head")).toHaveCount(1);
  await page.keyboard.press("3");
  await expect(page.locator(".hh-badge")).toHaveText("Staged");
  await expect(page.locator(".file", { hasText: "a.ts" }).locator(".st-partial")).toBeVisible();
  await expect(page.locator(".file", { hasText: "new.ts" }).locator(".st-none")).toBeVisible();
  await shot("all-view");
  await page.keyboard.press("1");
  await page.locator(".file", { hasText: "a.ts" }).click();
  await page.getByRole("button", { name: "Stage file" }).click();
  await expect(page.locator(".file")).toHaveCount(1);
  await expect(page.locator(".file.is-active .name")).toHaveText("new.ts");
  await page.keyboard.press("2");
  await expect(page.locator(".file", { hasText: "a.ts" })).toBeVisible();
  await page.keyboard.press("s");
  await expect(page.locator(".toast.show")).toContainText("Unstaged 2 lines in a.ts");
  const message = page.locator(".commit-box textarea");
  await message.fill(Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n"));
  await message.blur();
  await shot("staged-view");
  await page.keyboard.press("t");
  await shot("staged-view-dark");
  await page.keyboard.press("t");
  await message.fill("");
  await message.blur();
});

test("Ctrl+C copies selected code, c copies it for an agent, and context alone can't be staged", async () => {
  await page.keyboard.press("1");
  await page.locator(".file", { hasText: "a.ts" }).click();
  await expect(page.locator(".app")).toHaveAttribute("aria-busy", "false");
  const bLine = (n: number) => page.locator(".ln.b[data-line]", { hasText: new RegExp(`^${n}$`) });
  await bLine(3).click();
  await bLine(4).click({ modifiers: ["Shift"] });
  await expect(page.locator(".ln.b.sel")).toHaveCount(2);
  await expect(page.locator(".hunk-head.has-sel .hh-stage")).toHaveText(/^Stage 1 line/);
  const clipboard = () => app.evaluate(({ clipboard }) => clipboard.readText());

  await page.keyboard.press("Control+c");
  await expect(page.locator(".toast.show")).toContainText("Copied 2 lines");
  expect(await clipboard()).toBe("export const v2 = 2;\nexport const v3 = 1 + 3;\n");
  await page.keyboard.press("c");
  await expect(page.locator(".toast.show")).toContainText("Copied 2 lines for an agent");
  expect(await clipboard()).toBe("a.ts lines 3–4 (working tree)\n```diff\n export const v2 = 2;\n+export const v3 = 1 + 3;\n```\n");

  await page.keyboard.press("Escape");
  await bLine(2).click();
  await page.keyboard.press("s");
  await expect(page.locator(".toast.show")).toContainText("No changed lines selected");
  await page.locator(".file", { hasText: "new.ts" }).click();
  await expect(page.locator(".absent.a").first()).toBeVisible();
  await shot("absent-side");
});
