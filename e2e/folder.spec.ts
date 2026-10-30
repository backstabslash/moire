import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { gitIn, harness } from "./harness";

const { launch, shot, tmp, userData } = harness();
let folder: string;
let page: Page;

const write = (path: string, text: string) => {
  mkdirSync(join(folder, path, ".."), { recursive: true });
  writeFileSync(join(folder, path), text);
};

test.beforeAll(async () => {
  folder = tmp("folder");
  write(".gitignore", "node_modules/\n");
  write("README.md", "# Folder\n\nNot a repository.\n");
  write("src/main.ts", "export const answer = 42;\n");
  write("node_modules/dep/index.js", "module.exports = 1;\n");
  write("vendor/lib/a.txt", "vendored\n");
  gitIn(join(folder, "vendor"))("init", "-q");

  ({ page } = await launch(folder, { prefs: { theme: "light" } }));
  await expect(page.locator(".repo")).toContainText(basename(folder));
});

test("a folder that isn't a repository opens in All files, with the git views turned off", async () => {
  await expect(page.locator(".picker-btn")).toHaveText("Not a git repository");
  await expect(page.getByRole("group", { name: "Scope" })).toHaveCount(0);
  await expect(page.getByRole("group", { name: "Layout" })).toHaveCount(0);
  await expect(page.locator(".repo small")).toHaveText("folder");
  await expect(page.locator(".status .keys-list")).not.toContainText("hunk");
  await expect(page.locator(".empty-state h2")).toHaveText(`${basename(folder)} isn't a git repository.`);

  const changed = page.getByRole("button", { name: "Changed", exact: true });
  await expect(changed).toHaveAttribute("aria-disabled", "true");
  await changed.click({ force: true });
  const nav = page.getByRole("navigation", { name: "All files" });
  await expect(nav.locator(".tree-dir")).toHaveText(["node_modules", "src", "vendor"]);
  await expect(nav.locator(".tree-dir.is-ignored")).toHaveText("node_modules");

  await page.keyboard.press("a");
  await expect(page.locator(".toast.show")).toContainText(`${basename(folder)} isn't a git repository`);
  await page.keyboard.press("1");
  await expect(page.locator(".picker-btn")).toHaveText("Not a git repository");
  await shot("folder");
});

test("files read whole, a nested repository opens folder by folder, and search works", async () => {
  const nav = page.getByRole("navigation", { name: "All files" });
  await nav.locator('[data-tip^="README.md"]').click();
  await expect(page.locator(".row.uni .cell")).toHaveText(["# Folder", "", "Not a repository."]);

  await nav.locator(".tree-dir", { hasText: "vendor" }).click();
  await expect(nav.locator(".tree-dir", { hasText: "lib" })).toBeVisible();
  await expect(nav.locator(".tree-dir", { hasText: ".git" })).toHaveCount(0);
  await nav.locator(".tree-dir", { hasText: "lib" }).click();
  await nav.locator('[data-tip^="vendor/lib/a.txt"]').click();
  await expect(page.locator(".row.uni .cell")).toHaveText(["vendored"]);

  await nav.locator(".tree-dir", { hasText: "src" }).click();
  await nav.locator('[data-tip^="src/main.ts"]').click();
  await expect(page.locator(".row.uni .cell")).toHaveText(["export const answer = 42;"]);
  await page.keyboard.press("/");
  await expect(page.locator(".search input")).toBeFocused();
  await page.locator(".search input").fill("answer");
  await expect(page.locator(".search-status")).toHaveText("1 of 1");
  await page.keyboard.press("Escape");

  await page.keyboard.press("s");
  await expect(page.locator(".toast.show")).toContainText(`${basename(folder)} isn't a git repository`);
  await shot("folder-file");
});

test("a new file shows up in the tree", async () => {
  write("later.txt", "later\n");
  await expect(page.getByRole("navigation", { name: "All files" }).locator('[data-tip^="later.txt"]')).toBeVisible();
});

test("a nested repository cloned in later shows up in the tree", async () => {
  gitIn(folder)("init", "-q", "cloned");
  await expect(page.getByRole("navigation", { name: "All files" }).locator(".tree-dir", { hasText: "cloned" })).toBeVisible();
});

test("an opened folder joins recents but never becomes the last repo", () => {
  const state = JSON.parse(readFileSync(join(userData(), "state.json"), "utf8")) as { lastRepo?: string; recent?: string[] };
  expect(state.lastRepo).toBeUndefined();
  expect(state.recent).toEqual([folder]);
});

test("git init turns the folder into a repository without reopening it", async () => {
  gitIn(folder)("init", "-q");
  await expect(page.locator(".repo small")).not.toHaveText("folder");
  await expect(page.locator(".picker-btn")).not.toHaveText("Not a git repository");
  await expect(page.getByRole("button", { name: "Changed", exact: true })).not.toHaveAttribute("aria-disabled", "true");
  await expect(page.getByRole("navigation", { name: "All files" }).locator('[data-tip^="later.txt"]')).toContainText("later.txt");
  expect(await page.evaluate(() => localStorage.getItem("moire.files"))).toBe("changed");
  await page.keyboard.press("a");
  await expect(page.getByRole("navigation", { name: "Changed files" })).toBeVisible();
});

test("removing .git turns the repository back into a folder", async () => {
  rmSync(join(folder, ".git"), { recursive: true });
  await expect(page.locator(".repo small")).toHaveText("folder");
  await expect(page.getByRole("navigation", { name: "All files" }).locator('[data-tip^="later.txt"]')).toContainText("later.txt");
});

test("a folder moire was only started in leaves the last repo and recents alone", async () => {
  const data = tmp("data");
  const state = JSON.stringify({ lastRepo: "/some/repo", recent: ["/some/repo"] });
  writeFileSync(join(data, "state.json"), state);
  const plain = tmp("folder");
  const { app, page: win } = await launch([], { data, env: { MOIRE_REPO: plain } });
  await expect(win.locator(".repo")).toContainText(basename(plain));
  expect(readFileSync(join(data, "state.json"), "utf8")).toBe(state);
  await app.close();
});

test("starting in a folder reopens the last repo when there is one", async () => {
  const data = tmp("data");
  const repo = tmp("repo");
  gitIn(repo)("init", "-q");
  writeFileSync(join(data, "state.json"), JSON.stringify({ lastRepo: repo, recent: [repo] }));
  const { app, page: win } = await launch([], { data, env: { MOIRE_REPO: tmp("folder") } });
  await expect(win.locator(".repo")).toContainText(basename(repo));
  await app.close();
});
