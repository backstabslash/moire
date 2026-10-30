import { chmodSync, mkdirSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { harness } from "./harness";

const { clipboard, git, initRepo, launch, shot, shots } = harness();
let repo: string;
let page: Page;

const body = (tag: string) => Array.from({ length: 30 }, (_, i) => `export const ${tag}${i} = ${i};`).join("\n") + "\n";
const numbered = (edits: Record<number, string> = {}) => Array.from({ length: 200 }, (_, i) => edits[i + 1] ?? `line ${i + 1}`).join("\n") + "\n";
const write = (path: string, text: string) => {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), text);
};
const open = (name: string) => page.locator(`.file[data-path$="${name}"]`);

test.beforeAll(async () => {
  repo = initRepo();
  write("run.sh", "echo hi\n");
  write("a.ts", "a\n");
  symlinkSync("a.ts", join(repo, "link"));
  write("old.ts", body("v"));
  write("keep.ts", body("k"));
  write("ws.ts", body("w"));
  write("pnpm-lock.yaml", "lock: 1\n");
  write("src/main/index.ts", numbered());
  write("src/other/index.ts", "export const a = 1;\n");
  write("web/app.css", ".a {\n  color: red;\n}\n");
  git("add", "-A");
  git("commit", "-qm", "init");

  chmodSync(join(repo, "run.sh"), 0o755);
  unlinkSync(join(repo, "link"));
  symlinkSync("run.sh", join(repo, "link"));
  renameSync(join(repo, "old.ts"), join(repo, "new.ts"));
  write("new.ts", body("v").replace("v3 = 3", "v3 = 33"));
  renameSync(join(repo, "keep.ts"), join(repo, "kept.ts"));
  write(
    "ws.ts",
    body("w").replace("export const w2", "export  const w2").replace("export const w14", "export  const w14").replace("export const w25", "export  const w25"),
  );
  write("pnpm-lock.yaml", "lock: 2\n");
  write("src/main/index.ts", numbered({ 20: "edit 20", 150: "edit 150" }));
  write("src/other/index.ts", 'export const a = 2;\nexport const frame = "#1f252c";\n');
  write("web/app.css", ".a {\n  color: #bf3957;\n}\n");

  ({ page } = await launch(repo, { prefs: { theme: "light" } }));
  await expect(page.locator(".file")).toHaveCount(9);
});

test("mode changes and symlinks say what changed", async () => {
  await open("run.sh").click();
  await expect(open("run.sh").locator(".mode-tag")).toHaveText("+x");
  await expect(page.locator(".pane-mode").first()).toHaveText("now executable");
  await expect(page.locator(".note")).toHaveText("Now executable (100644 → 100755), no content changes.");
  await shots("mode");

  await open("link").click();
  await expect(page.locator(".note")).toHaveText("Symlink target changed from a.ts to run.sh.");
  await expect(open("link").locator(".mode-tag")).toHaveText("link");
  await shots("symlink");
});

test("a moved file shows as one rename, with its edit or a note if there's none", async () => {
  await expect(open("old.ts")).toHaveCount(0);
  await open("new.ts").click();
  await expect(open("new.ts").locator(".kind")).toHaveText("R");
  await expect(page.locator(".cell.add")).toHaveText(["export const v3 = 33;"]);
  await expect(page.locator(".pane-h b")).toHaveText(["old.ts", "new.ts"]);
  await expect(page.locator(".pane-h .w-del")).toHaveText("old");
  await expect(page.locator(".pane-h .w-add")).toHaveText("new");
  await expect(page.locator(".pane-h b").first()).toHaveAttribute("data-tip", /old\.ts/);

  await expect(open("keep.ts")).toHaveCount(0);
  await open("kept.ts").click();
  await expect(page.locator(".note")).toHaveText("Renamed, no content changes.");
  await expect(page.locator(".pane-h b")).toHaveText(["keep.ts", "kept.ts"]);
  await page.keyboard.press("v");
  await expect(page.locator(".pane-h b")).toHaveText(["keep.ts", "kept.ts"]);
  await expect(page.locator(".pane-arrow")).toBeVisible();
  await page.keyboard.press("v");
});

test("whitespace folds count their lines, and open one at a time or together", async () => {
  await open("ws.ts").click();
  const labels = page.locator(".hunk-head.is-folded .fold-label:not(.fold-all)");
  await expect(labels).toHaveCount(3);
  await expect(labels.first()).toHaveText(/^1 line, whitespace only, \d+ unchanged$/);
  await shots("ws-folds");
  await labels.first().click();
  await expect(labels).toHaveCount(2);
  await expect(page.locator(".cell.add")).toHaveText(["export  const w2 = 2;"]);
  await page.locator(".fold-all").first().click();
  await expect(page.locator(".hunk-head.is-folded")).toHaveCount(0);
});

test("lockfiles fold away until asked", async () => {
  await open("pnpm-lock.yaml").click();
  await expect(page.locator(".note")).toContainText("Lockfile, 2 changed lines, folded away.");
  await page.getByRole("button", { name: "Show changes" }).click();
  await expect(page.locator(".hunk-head")).toHaveCount(1);
});

test("the header says which folder a file is in", async () => {
  await open("src/other/index.ts").click();
  await expect(page.locator(".pane-dir")).toHaveText("src/other/");
  await expect(page.locator(".pane-h")).toHaveCount(1);
  await expect(page.locator(".pane-h b")).toHaveText("index.ts");
  await open("src/main/index.ts").click();
  await expect(page.locator(".pane-dir")).toHaveText("src/main/");

  await page.locator(".pane-dir button", { hasText: "src" }).click();
  const tree = page.getByRole("navigation", { name: "All files" });
  await expect(tree.locator('.tree-dir[data-dir="src/"]')).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("a");
});

test("long folds reveal twenty lines at a time", async () => {
  await open("src/main/index.ts").click();
  const fold = page.locator(".fold").nth(1);
  await expect(fold).toContainText("123 lines unchanged");
  await expect(fold.locator(".fold-step")).toHaveCount(2);
  await fold.hover();
  await shot("fold-steps");
  await fold.locator(".fold-step").first().click();
  await expect(page.locator(".fold").nth(1)).toContainText("103 lines unchanged");
  await page.locator(".fold").nth(1).locator(".fold-step").last().click();
  await expect(page.locator(".fold").nth(1)).toContainText("83 lines unchanged");
  await page.locator(".fold").nth(1).locator(".fold-open").click();
  await expect(page.getByText("83 lines unchanged")).toHaveCount(0);
});

test("colours get a swatch that copying leaves out", async () => {
  await open("web/app.css").click();
  await expect(page.locator(".cell.add .swatch")).toHaveCount(1);
  await open("src/other/index.ts").click();
  await expect(page.locator(".cell.add .swatch")).toHaveCount(1);
  await expect(page.locator(".cell.add").nth(1)).toHaveText('export const frame = "#1f252c";');
  await shot("swatch");
  await page
    .locator(".cell.add .text")
    .nth(1)
    .evaluate((el) => getSelection()!.selectAllChildren(el));
  await page.keyboard.press("ControlOrMeta+c");
  await expect.poll(clipboard).toBe('export const frame = "#1f252c";');
  await page.evaluate(() => getSelection()!.removeAllRanges());
});
