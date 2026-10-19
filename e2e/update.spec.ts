import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, type ElectronApplication, expect, test } from "@playwright/test";

let repo: string;
const userData: string[] = [];
const apps: ElectronApplication[] = [];

const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args]);

test.beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "moire-e2e-repo-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "e2e@example.com");
  git("config", "user.name", "e2e");
  writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  writeFileSync(join(repo, "a.ts"), "export const a = 2;\n");
});

test.afterAll(async () => {
  await Promise.all(apps.map((a) => a.close()));
  rmSync(repo, { recursive: true, force: true });
  for (const d of userData) rmSync(d, { recursive: true, force: true });
});

async function open(theme: string, update: object) {
  const data = mkdtempSync(join(tmpdir(), "moire-e2e-data-"));
  userData.push(data);
  const app = await electron.launch({
    args: [resolve("."), `--user-data-dir=${data}`, repo],
    env: { ...process.env, MOIRE_HIDDEN: "1", MOIRE_PREFS: JSON.stringify({ theme }), MOIRE_UPDATE: JSON.stringify(update) },
  });
  apps.push(app);
  const page = await app.firstWindow();
  await expect(page.locator(".hunk-head")).toHaveCount(1);
  return page;
}

for (const theme of ["light", "dark"]) {
  test(`a downloaded update offers a restart in the status bar (${theme})`, async () => {
    const page = await open(theme, { version: "9.9.9" });
    const button = page.locator(".status .update");
    await expect(button).toHaveText("Restart to update");
    await expect(button).toHaveAttribute("title", "Restarts moire on version 9.9.9");
    if (process.env.MOIRE_SHOTS) await page.locator(".status").screenshot({ path: join(process.env.MOIRE_SHOTS, `update-${theme}.png`) });
  });
}

test("a copy that can't update itself links to the release and says why", async () => {
  const page = await open("light", { version: "9.9.9", manualReason: "Installed from the .deb, so only your package manager can replace it." });
  const button = page.locator(".status .update");
  await expect(button).toHaveText("Get moire 9.9.9");
  await expect(button).toHaveAttribute("title", /package manager.*Opens the release page/);
});
