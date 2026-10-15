import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, type ElectronApplication, expect, type Page, test } from "@playwright/test";

let repo: string;
let userData: string;
let app: ElectronApplication;
let page: Page;
const errors: string[] = [];

const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
const shot = (name: string) => process.env.MOIRE_SHOTS && page.screenshot({ path: join(process.env.MOIRE_SHOTS, `${name}.png`) });
const body = Array.from({ length: 30 }, (_, i) => `export const v${i} = ${i};`);
const edited = body.map((l, i) => (i === 3 || i === 23 ? l.replace("=", "= 1 +") : l)).join("\n") + "\n";
const idle = () => expect(page.locator(".app")).toHaveAttribute("aria-busy", "false");

test.beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "moire-e2e-repo-"));
  userData = mkdtempSync(join(tmpdir(), "moire-e2e-data-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "e2e@example.com");
  git("config", "user.name", "e2e");
  writeFileSync(join(repo, "a.ts"), body.join("\n") + "\n");
  writeFileSync(join(repo, "img.bin"), Buffer.from([0, 1, 2, 3]));
  git("add", "-A");
  git("commit", "-qm", "init");
  writeFileSync(join(repo, "a.ts"), edited);
  writeFileSync(join(repo, "img.bin"), Buffer.from([0, 9, 9, 9]));
  writeFileSync(join(repo, "new.ts"), "export const fresh = true;\n");

  app = await electron.launch({ args: [resolve("."), `--user-data-dir=${userData}`, repo], env: { ...process.env, MOIRE_HIDDEN: "1" } });
  page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  await expect(page.locator(".file")).toHaveCount(3);
});

test.afterAll(async () => {
  await app?.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(userData, { recursive: true, force: true });
});

test.afterEach(() => {
  expect(errors).toEqual([]);
});

test("hunk buttons don't keep focus, so Enter can't repeat a discard on the next hunk", async () => {
  await page.locator(".file", { hasText: "a.ts" }).click();
  await idle();
  await page.locator(".hunk-head").first().hover();
  await page.locator(".hunk-head").first().locator(".hh-discard").click();
  await expect(page.locator(".toast.show")).toContainText("Discarded 2 lines in a.ts");
  await expect(page.locator(".hunk-head")).toHaveCount(1);
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("BUTTON");
  await page.keyboard.press("Enter");
  await expect(page.locator(".hunk-head")).toHaveCount(1);
  await page.keyboard.press("u");
  await expect(page.locator(".hunk-head")).toHaveCount(2);
  expect(readFileSync(join(repo, "a.ts"), "utf8")).toBe(edited);
});

test("Discard file throws away a binary file whole, and u brings it back", async () => {
  await page.locator(".file", { hasText: "img.bin" }).click();
  await idle();
  await shot("discard-file");
  await page.getByRole("button", { name: "Discard file" }).click();
  await expect(page.locator(".toast.show")).toContainText("Discarded img.bin");
  await expect(page.locator(".file")).toHaveCount(2);
  expect(readFileSync(join(repo, "img.bin"))).toEqual(Buffer.from([0, 1, 2, 3]));
  await page.keyboard.press("u");
  await expect(page.locator(".file")).toHaveCount(3);
  expect(readFileSync(join(repo, "img.bin"))).toEqual(Buffer.from([0, 9, 9, 9]));
});

test("a discard whose file changed since can't be undone, but can be saved next to it", async () => {
  await page.locator(".file", { hasText: "new.ts" }).click();
  await idle();
  await page.getByRole("button", { name: "Discard file" }).click();
  await expect(page.locator(".toast.show")).toContainText("Discarded new.ts");
  writeFileSync(join(repo, "new.ts"), "an agent wrote this\n");
  await expect(page.locator(".file", { hasText: "new.ts" })).toBeVisible();
  await idle();
  await page.keyboard.press("u");
  await expect(page.locator(".toast.show")).toContainText('Can\'t undo "Discarded new.ts": new.ts changed since.');
  await shot("refused-undo");
  await page.keyboard.press("t");
  await shot("refused-undo-dark");
  await page.keyboard.press("t");
  await page.getByRole("button", { name: "Save as new.ts.orig" }).click();
  await expect(page.locator(".toast.show")).toContainText("Saved new.ts.orig");
  expect(readFileSync(join(repo, "new.ts.orig"), "utf8")).toBe("export const fresh = true;\n");
  rmSync(join(repo, "new.ts.orig"));
  rmSync(join(repo, "new.ts"));
  await expect(page.locator(".file")).toHaveCount(2);
});

test("Stage all stages every file as one step, and Unstage all puts them back", async () => {
  await idle();
  await page.locator(".stage-progress").getByRole("button", { name: "Stage all" }).click();
  await expect(page.locator(".toast.show")).toContainText("Staged 2 files");
  await expect.poll(() => git("diff", "--cached", "--name-only")).toBe("a.ts\nimg.bin\n");
  await page.keyboard.press("u");
  await expect.poll(() => git("diff", "--cached", "--name-only")).toBe("");
  await idle();
  await page.keyboard.press("Shift+S");
  await expect.poll(() => git("diff", "--cached", "--name-only")).toBe("a.ts\nimg.bin\n");
  await page.keyboard.press("2");
  await idle();
  await expect(page.locator(".commit-box").getByRole("button", { name: "Unstage all" }).locator("kbd")).toHaveText("shift s");
  await page.keyboard.press("Shift+S");
  await expect(page.locator(".toast.show")).toContainText("Unstaged 2 files");
  await expect.poll(() => git("diff", "--cached", "--name-only")).toBe("");
  await page.keyboard.press("1");
});

test("a failed commit shows the hook's whole output until dismissed", async () => {
  await page.locator(".file", { hasText: "a.ts" }).click();
  await idle();
  await page.getByRole("button", { name: "Stage file" }).click();
  await expect(page.locator(".toast.show")).toContainText("Staged a.ts");
  const hook = join(repo, ".git", "hooks", "pre-commit");
  writeFileSync(hook, "#!/bin/sh\necho 'a.ts' >&2\necho '  4:1  error  Unexpected 1 + 3  no-implicit-math' >&2\necho '1 problem' >&2\nexit 1\n");
  chmodSync(hook, 0o755);
  await page.keyboard.press("2");
  await idle();
  const message = page.locator(".commit-box textarea");
  await message.fill("Change a");
  await message.press("Control+Enter");
  const panel = page.locator(".commit-error");
  await expect(panel.locator("pre")).toHaveText("a.ts\n  4:1  error  Unexpected 1 + 3  no-implicit-math\n1 problem");
  await message.blur();
  await page.waitForTimeout(5500);
  await expect(panel).toBeVisible();
  await shot("commit-error");
  await page.keyboard.press("t");
  await shot("commit-error-dark");
  await page.keyboard.press("t");
  await panel.getByRole("button", { name: "Copy" }).click();
  expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe("a.ts\n  4:1  error  Unexpected 1 + 3  no-implicit-math\n1 problem");
  await panel.getByRole("button", { name: "Dismiss" }).click();
  await expect(panel).toHaveCount(0);
  await expect(message).toHaveValue("Change a");

  rmSync(hook);
  await page.keyboard.press("1");
  await idle();
  await page.keyboard.press("2");
  await expect(message).toHaveValue("Change a");
  await message.press("Control+Enter");
  await expect(page.locator(".toast.show")).toContainText("Committed");
  expect(existsSync(hook)).toBe(false);
});
