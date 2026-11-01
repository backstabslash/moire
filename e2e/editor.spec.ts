import { execFileSync } from "node:child_process";
import { chmodSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { harness, lines, numbered } from "./harness";

const { commitAll, initRepo, launch, shot, tmp, userData } = harness();
let repo: string;
let bin: string;
let page: Page;

const { body, edit } = numbered(40);
const script = (name: string, log: string) => {
  writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s\\n' "$*" > ${join(bin, log)}\n`);
  chmodSync(join(bin, name), 0o755);
};
const logged = (log: string) =>
  expect.poll(() => {
    try {
      return readFileSync(join(bin, log), "utf8").trim();
    } catch {
      return "";
    }
  });

test.beforeAll(async () => {
  repo = initRepo();
  bin = tmp("bin");
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  symlinkSync(realGit, join(bin, "git"));
  writeFileSync(join(repo, "hunk.ts"), lines(body));
  commitAll("init");
  writeFileSync(join(repo, "hunk.ts"), lines(edit(3)));
  writeFileSync(join(repo, "a.txt"), "a\n");
  script("nvim", "nvim.log");
  writeFileSync(join(bin, "x-terminal-emulator"), `#!/bin/sh\nprintf '%s\\n' "$1" > ${join(bin, "terminal.log")}\nshift\nexec "$@"\n`);
  chmodSync(join(bin, "x-terminal-emulator"), 0o755);
  script("fake-gui", "gui.log");
  // ~/.local/bin is always searched, so only a saved editor that's missing reliably reaches the picker.
  writeFileSync(join(userData(), "state.json"), JSON.stringify({ editor: "missing-editor {file}" }));
  ({ page } = await launch(repo, { env: { MOIRE_EDITOR: "", PATH: `${bin}:${dirname(realGit)}` } }));
  await expect(page.locator(".file")).toHaveCount(2);
});

test("e with no editor asks for one, then opens the file, in a terminal for nvim", async () => {
  await page.keyboard.press("e");
  const nvim = page.getByRole("option", { name: /^nvim/ });
  await expect(nvim).toContainText("opens in a terminal");
  await shot("editor-picker");
  await nvim.click();
  await logged("terminal.log").toBe("-e");
  await logged("nvim.log").toBe(`+1 ${join(repo, "a.txt")}`);
  await expect(page.locator(".toast.show")).toContainText("Opened in nvim");
  expect(JSON.parse(readFileSync(join(userData(), "state.json"), "utf8")).editor).toBe("nvim +{line} {file}");
});

test("the choice sticks, and E changes it to a command of your own", async () => {
  rmSync(join(bin, "terminal.log"));
  await page.keyboard.press("e");
  await logged("terminal.log").toBe("-e");
  await expect(page.locator(".editor-pop")).toHaveCount(0);

  await page.keyboard.press("Shift+E");
  await page.getByLabel("Editor command").fill("fake-gui --line {line}");
  await page.getByLabel("Editor command").press("Enter");
  await expect(page.locator(".toast.show")).toContainText("Files will open in fake-gui");
  await page.keyboard.press("e");
  await logged("gui.log").toBe(`--line 1 ${join(repo, "a.txt")}`);
});

test("e opens the focused hunk's line", async () => {
  await page.locator(".file", { hasText: "hunk.ts" }).click();
  await expect(page.locator(".hunk-head")).toHaveCount(1);
  await page.keyboard.press("e");
  await logged("gui.log").toBe(`--line 4 ${join(repo, "hunk.ts")}`);
  await expect(page.locator(".toast.show")).toContainText("Opened in fake-gui");
});

test("a command that isn't installed is reported and nothing is saved", async () => {
  await page.keyboard.press("Shift+E");
  await page.getByLabel("Editor command").fill("not-an-editor");
  await page.getByLabel("Editor command").press("Enter");
  await expect(page.locator(".toast.show")).toContainText("Can't find not-an-editor");
  expect(JSON.parse(readFileSync(join(userData(), "state.json"), "utf8")).editor).toBe("fake-gui --line {line} {file}");
});
