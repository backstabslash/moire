import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { harness } from "./harness";

const { clipboard, git, idle, initRepo, launch, shot, shots, userData } = harness();
let repo: string;
let app: ElectronApplication;
let page: Page;

const clickMenu = (id: string) => app.evaluate(({ Menu }, id) => Menu.getApplicationMenu()?.getMenuItemById(id)?.click(), id);
const hunks = (text: string) => text.split("\n").filter((l) => l.startsWith("@@")).length;
const body = Array.from({ length: 60 }, (_, i) => `export const v${i} = ${i};`);
const edited = body.map((l, i) => (i % 15 === 3 ? l.replace("=", "= 1 +") : l)).join("\n") + "\n";

test.beforeAll(async () => {
  repo = initRepo();
  writeFileSync(join(repo, "a.ts"), body.join("\n") + "\n");
  writeFileSync(join(repo, "b.ts"), body.join("\n") + "\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  writeFileSync(join(repo, "a.ts"), edited);
  writeFileSync(join(repo, "b.ts"), body.slice(2).join("\n") + "\n");
  writeFileSync(join(userData(), "keys.json"), JSON.stringify({ stage: "w", stge: "x" }));

  ({ app, page } = await launch(repo, { prefs: { theme: "light" } }));
  await expect(page.locator(".file")).toHaveCount(2);
  await expect(page.locator(".hunk-head")).toHaveCount(4);
});

test("keys.json remaps a key, every label follows, and mistakes are reported", async () => {
  await expect(page.locator(".toast.show")).toHaveText('keys.json: No command is called "stge".');
  await expect(page.locator(".hunk-head.is-focus .hh-stage kbd")).toHaveText("w");
  await expect(page.locator(".status .keys button", { hasText: "stage" }).locator("kbd")).toHaveText("w");
  await page.keyboard.press("s");
  await page.keyboard.press("w");
  await expect(page.locator(".toast.show")).toContainText("Staged 2 lines in a.ts");
  expect(hunks(git("diff", "--cached"))).toBe(1);
  await page.keyboard.press("Control+z");
  await expect(page.locator(".toast.show")).toContainText("Undid: Staged 2 lines in a.ts");
  await expect.poll(() => git("diff", "--cached")).toBe("");
});

test("pressing stage while one runs queues it, so three presses stage three hunks", async () => {
  await idle();
  await page.keyboard.press("w");
  await page.keyboard.press("w");
  await page.keyboard.press("w");
  await expect.poll(() => hunks(git("diff", "--cached"))).toBe(3);
  await idle();
  expect(hunks(git("diff", "--", "a.ts"))).toBe(1);
  await page.locator(".toast button").click();
  for (let i = 0; i < 2; i++) {
    await idle();
    await clickMenu("undo");
  }
  await expect.poll(() => git("diff", "--cached")).toBe("");
});

test("? shows every key, remapped ones included, and closes with ? or Esc", async () => {
  await page.keyboard.press("?");
  const help = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(help).toBeVisible();
  await expect(help.locator(".keys-row", { has: page.getByText("Stage or unstage", { exact: true }) }).locator("kbd")).toHaveText("w");
  await expect(help.locator(".keys-row", { hasText: "First hunk" }).locator("kbd")).toHaveText("g g");
  await expect(help.locator("h3")).toHaveText(["Navigate", "Review", "Copy", "View"]);
  await shot("keys-help-light");
  const focused = page.locator(".hunk-head.is-focus .hh-range");
  const before = await focused.textContent();
  await page.keyboard.press("j");
  await expect(focused).toHaveText(before!);
  await page.keyboard.press("Escape");
  await expect(help).toBeHidden();
  await page.keyboard.press("t");
  await page.keyboard.press("?");
  await shot("keys-help-dark");
  await page.keyboard.press("?");
  await expect(help).toBeHidden();
  await page.keyboard.press("t");
});

test("the status bar's help button opens the shortcuts, and a second click closes them", async () => {
  const button = page.locator('[data-command="help"]');
  const help = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await button.click();
  await expect(help).toBeVisible();
  await button.click();
  await expect(help).toHaveCount(0);
  await button.click();
  await page.locator(".keys-groups").click();
  await expect(help).toBeVisible();
  await page.locator(".brand").click();
  await expect(help).toHaveCount(0);
});

test("buttons show their keys only when the shortcuts dialog says so, and the dialog shows the version", async () => {
  const stageKey = page.locator(".hunk-head.is-focus .hh-stage kbd");
  await expect(stageKey).toBeHidden();
  await expect(page.locator(".status .keys kbd").first()).toBeVisible();
  await page.keyboard.press("?");
  const help = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(help.locator(".keys-version")).toHaveText(/^moire \d+\.\d+\.\d+/);
  await help.getByLabel("Show shortcuts on buttons").check();
  await expect(stageKey).toBeVisible();
  await help.getByLabel("Show shortcuts on buttons").uncheck();
  await expect(stageKey).toBeHidden();
  await page.keyboard.press("Escape");
});

test("menu items run through the same commands", async () => {
  await clickMenu("nextFile");
  await expect(page.locator(".file.is-active .name")).toHaveText("b.ts");
  await clickMenu("prevFile");
  await expect(page.locator(".file.is-active .name")).toHaveText("a.ts");
  await clickMenu("help");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
  await clickMenu("layout");
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeHidden();
  await expect(page.locator(".row.uni").first()).toBeVisible();
  await clickMenu("layout");
  await expect(page.locator(".row.split").first()).toBeVisible();
});

test("g g and G jump to the first and last hunk, and c copies the focused hunk", async () => {
  await page.keyboard.press("Shift+G");
  await expect(page.locator(".hunk-head.is-focus .hh-range")).toHaveText(/^−46,/);
  await page.keyboard.press("g");
  await page.keyboard.press("g");
  await expect(page.locator(".hunk-head.is-focus .hh-range")).toHaveText(/^−1,/);
  await page.keyboard.press("c");
  await expect(page.locator(".toast.show")).toContainText("for an agent");
  expect(await clipboard()).toContain("+export const v3 = 1 + 3;");
});

test("a selection gets copy buttons, and Shift+J extends it", async () => {
  await page.locator(".ln.b.add[data-line]").first().click();
  const head = page.locator(".hunk-head.has-sel");
  await expect(head.locator(".hh-copy")).toHaveText([/^Copy/, /^Markdown/]);
  await page.keyboard.press("Shift+J");
  await page.keyboard.press("Shift+J");
  await expect(page.locator(".ln.b.sel")).toHaveCount(3);
  await page.keyboard.press("Shift+K");
  await expect(page.locator(".ln.b.sel")).toHaveCount(2);
  await shots("selection-buttons");
  await head.getByRole("button", { name: /^Copy/ }).click();
  expect(await clipboard()).toBe("export const v3 = 1 + 3;\nexport const v4 = 4;\n");
  await head.getByRole("button", { name: /^Markdown/ }).click();
  expect(await clipboard()).toMatch(/^a\.ts lines 4–5 \(working tree\)\n```diff\n/);
  await page.keyboard.press("Escape");
  await expect(page.locator(".ln.sel")).toHaveCount(0);
});

test("arrow keys walk the file list after a click there, and the toolbar opens search", async () => {
  await page.locator(".file", { hasText: "a.ts" }).click();
  await page.keyboard.press("ArrowDown");
  await expect(page.locator(".file.is-active .name")).toHaveText("b.ts");
  await page.keyboard.press("ArrowUp");
  await expect(page.locator(".file.is-active .name")).toHaveText("a.ts");
  await page.locator(".diff").click();
  await page.keyboard.press("ArrowDown");
  await expect(page.locator(".file.is-active .name")).toHaveText("a.ts");

  await page.getByRole("button", { name: "Search (/)" }).click();
  await expect(page.getByRole("textbox", { name: "Search" })).toBeFocused();
  await page.keyboard.press("Escape");
});

test("editing keys.json applies without a restart", async () => {
  writeFileSync(join(userData(), "keys.json"), JSON.stringify({ stage: "s", nextFile: "n" }));
  await expect(page.locator(".toast.show")).toHaveText("keys.json: nextFile and nextHit both use n, so nextFile keeps its default.");
  await expect(page.locator(".status .keys button", { hasText: "stage" }).locator("kbd")).toHaveText("s");
});

test("Edit keyboard shortcuts writes the defaults when there's no file and opens it", async () => {
  const file = join(userData(), "keys.json");
  rmSync(file);
  await app.evaluate(({ shell }) => {
    const opened: string[] = [];
    (globalThis as { opened?: string[] }).opened = opened;
    shell.openPath = async (path) => {
      opened.push(path);
      return "";
    };
  });
  await page.keyboard.press("?");
  await page.getByRole("button", { name: "Edit keyboard shortcuts…" }).click();
  await expect.poll(() => existsSync(file)).toBe(true);
  expect(await app.evaluate(() => (globalThis as { opened?: string[] }).opened)).toEqual([file]);
  const written = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  expect(written.stage).toBe("s");
  expect(written.search).toEqual(["/", "Mod+f"]);
  await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeHidden();
});
