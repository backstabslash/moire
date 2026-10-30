import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { gitIn, harness, png } from "./harness";

const { git, initRepo, launch, shots } = harness();
let repo: string;
let sub: string;
let page: Page;

const write = (path: string, data: string | Buffer) => {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), data);
};

const oid = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const pointer = (data: Buffer) => `version https://git-lfs.github.com/spec/v1\noid sha256:${oid(data)}\nsize ${data.length}\n`;
const store = (data: Buffer) => write(`.git/lfs/objects/${oid(data).slice(0, 2)}/${oid(data).slice(2, 4)}/${oid(data)}`, data);
const stored = png(60, 30, [10, 140, 160]);

test.beforeAll(async () => {
  repo = initRepo();
  sub = initRepo();
  writeFileSync(join(sub, "inner.txt"), "inner\n");
  gitIn(sub)("add", "-A");
  gitIn(sub)("commit", "-qm", "init");

  write(".gitattributes", "*.png filter=lfs diff=lfs merge=lfs -text\n");
  write("latin.txt", "menu\ncafe\n");
  write("img/logo.png", pointer(png(40, 20, [204, 34, 80])));
  write("img/icon.png", pointer(png(8, 8, [0, 0, 0])));
  git("-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "sub");
  git("add", "-A");
  git("commit", "-qm", "init");

  write("latin.txt", Buffer.from("menu\ncaf\xe9\n", "latin1"));
  write("img/icon.png", png(16, 16, [10, 140, 160]));
  writeFileSync(join(repo, "sub", "inner.txt"), "edited\n");
  write("img/logo.png", pointer(stored));
  store(stored);
  git("add", "img/logo.png");

  ({ page } = await launch(repo));
  await expect(page.locator(".file")).toHaveCount(3);
});

test("a file that isn't UTF-8 says why it shows replacement characters", async () => {
  await page.locator(".file", { hasText: "latin.txt" }).click();
  await expect(page.locator(".cell.b", { hasText: "caf�" })).toBeVisible();
  await expect(page.locator(".encoding")).toHaveText(/isn't UTF-8 \(perhaps Latin-1\).*It can only be staged whole\./);
  await shots("encoding");

  await page.locator(".file", { hasText: "sub" }).click();
  await expect(page.locator(".encoding")).toHaveCount(0);
});

test("a submodule with edits inside it shows a note, not its commit lines", async () => {
  await page.locator(".file", { hasText: "sub" }).click();
  await expect(page.locator(".note")).toHaveText("Submodule has uncommitted changes inside it.");
});

test("images in Git LFS preview the stored file, and say when it isn't downloaded", async () => {
  await page.locator(".file", { hasText: "icon.png" }).click();
  await expect(page.locator(".img-side.a .img-failed")).toHaveText("Stored in Git LFS and not downloaded. git lfs pull fetches it.");
  await expect(page.locator(".img-side.b figcaption")).toHaveText(/^16 × 16, \d+ B$/);

  await page.keyboard.press("2");
  await page.locator(".file", { hasText: "logo.png" }).click();
  await expect(page.locator(".img-side.b figcaption")).toHaveText(`60 × 30, ${stored.length} B`);
  await expect(page.locator(".img-side.a .img-failed")).toHaveText("Stored in Git LFS and not downloaded. git lfs pull fetches it.");
  await shots("lfs");
  await page.keyboard.press("1");
});
