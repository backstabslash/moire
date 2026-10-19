import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "@playwright/test";

export default async function warmup() {
  const repo = mkdtempSync(join(tmpdir(), "moire-e2e-repo-"));
  const userData = mkdtempSync(join(tmpdir(), "moire-e2e-data-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args]);
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
  git("add", "-A");
  git("-c", "user.email=e2e@example.com", "-c", "user.name=e2e", "commit", "-qm", "init");
  writeFileSync(join(repo, "a.ts"), "export const a = 2;\n");
  const app = await electron.launch({ args: [resolve("."), `--user-data-dir=${userData}`, repo], env: { ...process.env, MOIRE_HIDDEN: "1" } });
  try {
    await (await app.firstWindow()).locator(".cell span[style]").first().waitFor({ timeout: 60_000 });
  } finally {
    await app.close();
    rmSync(repo, { recursive: true, force: true });
    rmSync(userData, { recursive: true, force: true });
  }
}
