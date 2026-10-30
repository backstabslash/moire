import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { harness } from "./harness";

const { git, initRepo, launch, shots, tmp } = harness();
let repo: string;

test.beforeAll(() => {
  repo = initRepo();
  writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  writeFileSync(join(repo, "a.ts"), "export const a = 2;\n");
});

async function open(update: object) {
  const launched = await launch(repo, { data: tmp("data"), prefs: { theme: "light" }, env: { MOIRE_UPDATE: JSON.stringify(update) } });
  await expect(launched.page.locator(".hunk-head")).toHaveCount(1);
  return launched;
}

test("a downloaded update offers a restart in the status bar", async () => {
  const { app, page } = await open({ version: "9.9.9" });
  const button = page.locator(".status .update");
  await expect(button).toHaveText("Restart to update");
  await expect(button).toHaveAttribute("data-tip", /9\.9\.9/);
  await shots("update", page.locator(".status"));
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("update:apply");
    ipcMain.handle("update:apply", () => {
      (globalThis as { applied?: boolean }).applied = true;
    });
  });
  await button.click();
  await expect.poll(() => app.evaluate(() => (globalThis as { applied?: boolean }).applied)).toBe(true);
});

test("a copy that can't update itself links to the release and says why", async () => {
  const { page } = await open({ version: "9.9.9", manualReason: "Installed from the .deb, so only your package manager can replace it." });
  const button = page.locator(".status .update");
  await expect(button).toHaveText("Get moire 9.9.9");
  await expect(button).toHaveAttribute("data-tip", /package manager/);
});
