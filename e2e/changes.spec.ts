import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { _electron as electron, type ElectronApplication, expect, type Page, test } from "@playwright/test";

let repo: string;
let userData: string;
let app: ElectronApplication;
let page: Page;
const errors: string[] = [];

const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
const shot = (name: string) => process.env.MOIRE_SHOTS && page.screenshot({ path: join(process.env.MOIRE_SHOTS, `${name}.png`) });
const body = (tag: string) => Array.from({ length: 30 }, (_, i) => `export const ${tag}${i} = ${i};`).join("\n") + "\n";
const write = (path: string, text: string) => writeFileSync(join(repo, path), text);
const open = (name: string) => page.locator(".file", { has: page.locator(".name", { hasText: new RegExp(`^${name}$`) }) });

test.beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "moire-e2e-repo-"));
  userData = mkdtempSync(join(tmpdir(), "moire-e2e-data-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "e2e@example.com");
  git("config", "user.name", "e2e");
  write("run.sh", "echo hi\n");
  write("a.ts", "a\n");
  symlinkSync("a.ts", join(repo, "link"));
  write("old.ts", body("v"));
  write("ws.ts", body("w"));
  write("bundle.js", "x\n");
  mkdirSync(join(repo, "__snapshots__"));
  write("__snapshots__/a.test.ts.snap", 'exports[`a`] = `"ok"`;\n');
  git("add", "-A");
  git("commit", "-qm", "init");

  chmodSync(join(repo, "run.sh"), 0o755);
  unlinkSync(join(repo, "link"));
  symlinkSync("run.sh", join(repo, "link"));
  renameSync(join(repo, "old.ts"), join(repo, "new.ts"));
  write("new.ts", body("v").replace("v3 = 3", "v3 = 33"));
  write("ws.ts", body("w").replace("export const w2", "export  const w2").replace("export const w25", "export  const w25"));
  write("bundle.js", `${"var a=1;".repeat(4000)}\n`);
  write("__snapshots__/a.test.ts.snap", 'exports[`a`] = `"tampered"`;\n');

  app = await electron.launch({
    args: [resolve("."), `--user-data-dir=${userData}`, repo],
    env: { ...process.env, MOIRE_HIDDEN: "1", MOIRE_PREFS: '{"theme":"light"}' },
  });
  page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  await expect(page.locator(".file")).toHaveCount(6);
});

test.afterAll(async () => {
  await app?.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(userData, { recursive: true, force: true });
});

test.afterEach(() => {
  expect(errors).toEqual([]);
});

test("mode changes and symlinks say what changed", async () => {
  await open("run.sh").click();
  await expect(open("run.sh").locator(".mode-tag")).toHaveText("+x");
  await expect(page.locator(".pane-mode").first()).toHaveText("now executable");
  await expect(page.locator(".note")).toHaveText("Now executable (100644 → 100755), no content changes.");
  await shot("mode-light");
  await page.keyboard.press("t");
  await shot("mode-dark");
  await page.keyboard.press("t");

  await open("link").click();
  await expect(page.locator(".note")).toHaveText("Symlink target changed from a.ts to run.sh.");
  await expect(open("link").locator(".mode-tag")).toHaveText("link");
  await shot("symlink-light");
  await page.keyboard.press("t");
  await shot("symlink-dark");
  await page.keyboard.press("t");
});

test("a moved and edited file shows as one rename with the edit", async () => {
  await expect(open("old.ts")).toHaveCount(0);
  await open("new.ts").click();
  await expect(open("new.ts").locator(".kind")).toHaveText("R");
  await expect(page.locator(".cell.add")).toHaveText(["export const v3 = 33;"]);
});

test("whitespace folds count their lines and expand together", async () => {
  await open("ws.ts").click();
  const labels = page.locator(".hunk-head.is-folded .fold-label:not(.fold-all)");
  await expect(labels).toHaveCount(2);
  await expect(labels.first()).toHaveText(/^1 line · whitespace only · \d+ unchanged$/);
  await shot("ws-folds-light");
  await page.keyboard.press("t");
  await shot("ws-folds-dark");
  await page.keyboard.press("t");
  await page.locator(".fold-all").first().click();
  await expect(page.locator(".hunk-head.is-folded")).toHaveCount(0);
});

test("minified files fold, snapshots don't", async () => {
  await open("bundle.js").click();
  await expect(page.locator(".note")).toHaveText(/^Minified file, 2 changed lines, folded away\./);
  await open("a.test.ts.snap").click();
  await expect(page.locator(".cell.add")).toContainText(["tampered"]);
});

test("files written into a directory made earlier show up", async () => {
  mkdirSync(join(repo, "deep", "er", "still"), { recursive: true });
  await sleep(600);
  write("deep/er/still/x.ts", "x\n");
  await expect(open("x.ts")).toHaveCount(1);
});
