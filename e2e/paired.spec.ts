import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { _electron as electron, type ElectronApplication, expect, type Page, test } from "@playwright/test";

let base: string;
let repo: string;
let userData: string;
let app: ElectronApplication;
let page: Page;
const errors: string[] = [];

const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args]);
const sideShot = (name: string) => process.env.MOIRE_SHOTS && page.locator(".sidebar").screenshot({ path: join(process.env.MOIRE_SHOTS, `${name}.png`) });
const write = (path: string, text: string) => {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), text);
};
const lines = (name: string, n: number, from = 0) => Array.from({ length: n }, (_, i) => `export const ${name}${i} = ${i + from};`).join("\n") + "\n";

const TRACKED = [
  "src/components/checkout/CartSummary.tsx",
  "src/components/checkout/CartSummary.module.css",
  "src/components/checkout/index.ts",
  "src/hooks/useCart.ts",
  "src/lib/money/format.ts",
  "src/lib/money/round.ts",
  "src/locales/en.json",
  "src/locales/de.json",
  "src/server/routes/orders.ts",
  "src/server/db/schema.ts",
  "tests/components/checkout/CartSummary.test.tsx",
  "tests/lib/money/format.test.ts",
  "docs/checkout.md",
  "package.json",
  ".github/workflows/ci.yml",
];
const ADDED = [
  "src/components/checkout/CurrencyPicker.tsx",
  "src/components/checkout/CurrencyPicker.module.css",
  "src/lib/money/currency.ts",
  "src/server/db/migrations/0042_order_currency.sql",
  "tests/lib/money/currency.test.ts",
];

const PAIRED = [
  "src/components/checkout/CartSummary.tsx",
  "src/components/checkout/CartSummary.module.css",
  "tests/components/checkout/CartSummary.test.tsx",
  "src/components/checkout/CurrencyPicker.tsx",
  "src/components/checkout/CurrencyPicker.module.css",
  "src/components/checkout/index.ts",
  "src/hooks/useCart.ts",
  "src/lib/money/currency.ts",
  "tests/lib/money/currency.test.ts",
  "src/lib/money/format.ts",
  "tests/lib/money/format.test.ts",
  "src/lib/money/round.ts",
  "src/locales/de.json",
  "src/locales/en.json",
  "src/server/db/migrations/0042_order_currency.sql",
  "src/server/db/schema.ts",
  "src/server/routes/orders.ts",
  "package.json",
  ".github/workflows/ci.yml",
  "docs/checkout.md",
  "pnpm-lock.yaml",
];

async function launch() {
  app = await electron.launch({
    args: [resolve("."), `--user-data-dir=${userData}`, repo],
    env: { ...process.env, MOIRE_HIDDEN: "1", MOIRE_PREFS: '{"theme":"light"}' },
  });
  page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 1300));
  await expect(page.locator(".files .file")).toHaveCount(PAIRED.length);
}

const shown = () => page.locator(".files .file").evaluateAll((els) => els.map((e) => (e as HTMLElement).title.split("\n")[0]));

test.beforeAll(async () => {
  base = mkdtempSync(join(tmpdir(), "moire-e2e-repo-"));
  repo = join(base, "shop");
  mkdirSync(repo);
  userData = mkdtempSync(join(tmpdir(), "moire-e2e-data-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "e2e@example.com");
  git("config", "user.name", "e2e");
  for (const path of TRACKED) write(path, lines("v", 30));
  write("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  for (const path of TRACKED) write(path, lines("v", 32, 1));
  for (const path of ADDED) write(path, lines("n", 12));
  write("pnpm-lock.yaml", "lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: true\n");
  rmSync(join(repo, "src/lib/money/round.ts"));
  await launch();
});

test.afterAll(async () => {
  await app?.close();
  rmSync(base, { recursive: true, force: true });
  rmSync(userData, { recursive: true, force: true });
});

test.afterEach(() => {
  expect(errors).toEqual([]);
});

test("the Changed list pairs files by module, with tests under their source", async () => {
  expect(await shown()).toEqual(PAIRED);
  await expect(page.locator(".side-head .grouping")).toHaveText("Paired");
  await expect(page.locator(".files .dir bdi")).toHaveText(["components/checkout", "hooks", "lib/money", "locales", "server/db", "server/routes"]);
  await expect(page.locator(".files .dir .roots")).toHaveCount(2);
  await expect(page.locator(".files .tier")).toHaveText(["Config and CI2", "Docs1", "Folded1"]);
  await expect(page.locator(".file.sib")).toHaveCount(5);
  await expect(page.locator(".slot-empty")).toHaveText([".test.tsxno test change", ".test.tsno test change", ".test.tsno test change"]);
  await expect(page.locator(".file", { hasText: "0042_order_currency.sql" }).locator(".name")).toHaveAttribute("data-hint", "migrations/");

  await page.locator(".file", { hasText: "CartSummary.tsx" }).click();
  await expect(page.locator(".pane-h").first()).toBeVisible();
  await sideShot("paired-light");
  await page.keyboard.press("t");
  await expect(page.locator("html")).toHaveAttribute("data-tone", "dark");
  await sideShot("paired-dark");
  await page.keyboard.press("t");
});

test("] and [ walk the files in the order the list shows them", async () => {
  await page.locator(".files .file").first().click();
  const walked = [];
  for (let i = 0; i < PAIRED.length; i++) {
    await expect(page.locator(".file.is-active")).toHaveCount(1);
    walked.push((await page.locator(".file.is-active").getAttribute("title"))!.split("\n")[0]);
    await page.keyboard.press("]");
  }
  expect(walked).toEqual(PAIRED);
  await page.keyboard.press("[");
  await expect(page.locator(".file.is-active")).toHaveAttribute("title", /^docs\/checkout\.md/);
});

test("l switches to By folder, which survives a restart", async () => {
  await page.keyboard.press("l");
  await expect(page.locator(".side-head .grouping")).toHaveText("By folder");
  await expect(page.locator(".file.sib, .slot-empty, .files .tier")).toHaveCount(0);
  await expect(page.locator(".files .dir").first()).toHaveText(".github/workflows");
  const byFolder = await shown();
  expect(byFolder.slice(0, 2)).toEqual(["package.json", "pnpm-lock.yaml"]);

  await page.locator(".files .file").first().click();
  await page.keyboard.press("]");
  await expect(page.locator(".file.is-active")).toHaveAttribute("title", new RegExp(`^${byFolder[1]}`));

  await app.close();
  await launch();
  await expect(page.locator(".side-head .grouping")).toHaveText("By folder");
  expect(await shown()).toEqual(byFolder);
  await page.locator(".side-head .grouping").click();
  await expect(page.locator(".side-head .grouping")).toHaveText("Paired");
  expect(await shown()).toEqual(PAIRED);
});

test("the filter keeps the paired layout for the files it matches", async () => {
  await page.keyboard.press("p");
  await page.keyboard.type("lib/money");
  await expect(page.locator(".files .dir bdi")).toHaveText(["lib/money"]);
  expect(await shown()).toEqual(PAIRED.filter((p) => p.includes("lib/money")));
  await expect(page.locator(".slot-empty")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.locator(".files .file")).toHaveCount(PAIRED.length);
});

test("staged files dim in place in the All view", async () => {
  git("add", "src/components/checkout/CartSummary.module.css", "src/lib/money/format.ts");
  await page.keyboard.press("3");
  await expect(page.locator(".file.is-staged")).toHaveCount(2);
  expect(await shown()).toEqual(PAIRED);
  await sideShot("paired-staged");
  await page.keyboard.press("1");
});
