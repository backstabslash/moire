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
const shot = (name: string) => process.env.MOIRE_SHOTS && page.screenshot({ path: join(process.env.MOIRE_SHOTS, `${name}.png`) });
const body = Array.from({ length: 60 }, (_, i) => `export const v${i} = ${i};`);
const write = (lines: string[]) => writeFileSync(join(repo, "a.ts"), lines.join("\n") + "\n");

async function launch() {
  app = await electron.launch({ args: [resolve("."), `--user-data-dir=${userData}`, repo], env: { ...process.env, MOIRE_HIDDEN: "1" } });
  page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
}

test.beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "moire-e2e-repo-"));
  userData = mkdtempSync(join(tmpdir(), "moire-e2e-data-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "e2e@example.com");
  git("config", "user.name", "e2e");
  write(body);
  writeFileSync(join(repo, "b.ts"), "export const b = 1;\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  write(body.map((l, i) => (i === 30 ? l.replace("= 30", "= 300") : l)));
  writeFileSync(join(repo, "b.ts"), "export const b = 2;\n");
  await launch();
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

test("with everything staged, Unstaged says so and leads on to the commit", async () => {
  git("add", "-A");
  await expect(page.locator(".empty-state h2")).toHaveText("All 2 changes are staged.");
  await expect(page.locator(".sidebar")).toBeVisible();
  await expect(page.locator(".stage-progress")).toContainText("2 of 2 staged");
  await shot("all-staged");

  await page.locator(".empty-actions").getByRole("button", { name: "Commit" }).click();
  await expect(page.locator(".picker-btn")).toHaveText("Staged");
  const box = page.getByLabel("Commit message");
  await expect(box).toBeFocused();
  await box.fill("Make v30 bigger\n\nAnd b too.");
  await box.press("Control+Enter");

  await expect(page.locator(".empty-state h2")).toHaveText("Committed.");
  await expect(page.locator(".empty-state p")).toHaveText(/^[0-9a-f]{7,} Make v30 bigger$/);
  await expect(page.locator(".sidebar")).toBeVisible();
  await shot("committed");

  await page.getByRole("button", { name: "Show commit" }).click();
  await expect(page.locator(".picker-btn")).toHaveText("Commit");
  await expect(page.locator(".commit-head")).toContainText("Make v30 bigger");
  await expect(page.locator(".commit-head")).toContainText("e2e");
  await expect(page.locator(".commit-body")).toHaveCount(0);
  await page.locator(".commit-subject").click();
  await expect(page.locator(".commit-body")).toHaveText("And b too.");
  await shot("commit-head");
});

test("a selection stays put while lines change elsewhere, and clears when its own lines change", async () => {
  await page.keyboard.press("1");
  write(body.map((l, i) => (i === 30 ? l.replace("= 30", "= 3000") : l)));
  await expect(page.locator(".file")).toHaveCount(1);
  const bLine = (n: number) => page.locator(".ln.b[data-line]", { hasText: new RegExp(`^${n}$`) });
  await bLine(30).click();
  await bLine(31).click({ modifiers: ["Shift"] });
  const picked = page.locator(".cell.b.sel");
  await expect(picked).toHaveText(["export const v29 = 29;", "export const v30 = 3000;"]);

  write(["// one", "// two", ...body.map((l, i) => (i === 30 ? l.replace("= 30", "= 3000") : l))]);
  await expect(page.locator(".hunk-head")).toHaveCount(2);
  await expect(picked).toHaveText(["export const v29 = 29;", "export const v30 = 3000;"]);
  await expect(page.locator(".ln.b.sel")).toHaveText(["32", "33"]);

  write(["// one", "// two", ...body.map((l, i) => (i === 30 ? l.replace("= 30", "= 30000") : l))]);
  await expect(page.locator(".cell.b", { hasText: "30000" })).toBeVisible();
  await expect(picked).toHaveCount(0);
});

test("the open file and the sidebar width come back after a restart", async () => {
  writeFileSync(join(repo, "b.ts"), "export const b = 3;\n");
  await page.locator(".file", { hasText: "b.ts" }).click();
  await expect(page.locator(".file.is-active .name")).toHaveText("b.ts");
  const edge = (await page.locator(".side-resize").boundingBox())!;
  await page.mouse.move(edge.x + edge.width / 2, edge.y + 200);
  await page.mouse.down();
  await page.mouse.move(edge.x + edge.width / 2 + 100, edge.y + 200, { steps: 4 });
  await page.mouse.up();
  const width = (await page.locator(".sidebar").boundingBox())!.width;
  expect(width).toBeGreaterThan(330);

  await app.close();
  await launch();
  await expect(page.locator(".file.is-active .name")).toHaveText("b.ts");
  expect((await page.locator(".sidebar").boundingBox())!.width).toBe(width);
});
