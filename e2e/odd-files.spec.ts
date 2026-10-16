import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { _electron as electron, type ElectronApplication, expect, type Page, test } from "@playwright/test";

let repo: string;
let sub: string;
let userData: string;
let app: ElectronApplication;
let page: Page;
const errors: string[] = [];

const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
const write = (path: string, data: string | Buffer) => {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), data);
};
const shot = (name: string) => process.env.MOIRE_SHOTS && page.screenshot({ path: join(process.env.MOIRE_SHOTS, `${name}.png`) });

function png(width: number, height: number, [r, g, b]: number[]) {
  const chunk = (type: string, data: Buffer) => {
    const out = Buffer.alloc(data.length + 12);
    out.writeUInt32BE(data.length);
    out.write(type, 4, "ascii");
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.from([0, ...Array.from({ length: width }, () => [r, g, b]).flat()]);
  const pixels = deflateSync(Buffer.concat(Array.from({ length: height }, () => row)));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", pixels), chunk("IEND", Buffer.alloc(0))]);
}

const oid = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const pointer = (data: Buffer) => `version https://git-lfs.github.com/spec/v1\noid sha256:${oid(data)}\nsize ${data.length}\n`;
const store = (data: Buffer) => write(`.git/lfs/objects/${oid(data).slice(0, 2)}/${oid(data).slice(2, 4)}/${oid(data)}`, data);
const stored = png(60, 30, [10, 140, 160]);

test.beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "moire-e2e-repo-"));
  sub = mkdtempSync(join(tmpdir(), "moire-e2e-sub-"));
  userData = mkdtempSync(join(tmpdir(), "moire-e2e-data-"));
  execFileSync("git", ["-C", sub, "init", "-q", "-b", "main"]);
  writeFileSync(join(sub, "inner.txt"), "inner\n");
  execFileSync("git", ["-C", sub, "add", "-A"]);
  execFileSync("git", ["-C", sub, "-c", "user.name=e2e", "-c", "user.email=e2e@example.com", "commit", "-qm", "init"]);

  git("init", "-q", "-b", "main");
  git("config", "user.email", "e2e@example.com");
  git("config", "user.name", "e2e");
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

  app = await electron.launch({ args: [resolve("."), `--user-data-dir=${userData}`, repo], env: { ...process.env, MOIRE_HIDDEN: "1" } });
  page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  await expect(page.locator(".file")).toHaveCount(3);
});

test.afterAll(async () => {
  await app?.close();
  rmSync(repo, { recursive: true, force: true });
  rmSync(sub, { recursive: true, force: true });
  rmSync(userData, { recursive: true, force: true });
});

test.afterEach(() => {
  expect(errors).toEqual([]);
});

test("a file that isn't UTF-8 says why it shows replacement characters", async () => {
  await page.locator(".file", { hasText: "latin.txt" }).click();
  await expect(page.locator(".cell.b", { hasText: "caf�" })).toBeVisible();
  await expect(page.locator(".encoding")).toHaveText(/isn't UTF-8 \(perhaps Latin-1\).*It can only be staged whole\./);
  await shot("encoding-light");
  await page.keyboard.press("t");
  await shot("encoding-dark");
  await page.keyboard.press("t");

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
  await shot("lfs-light");
  await page.keyboard.press("t");
  await shot("lfs-dark");
  await page.keyboard.press("t");
  await page.keyboard.press("1");
});
