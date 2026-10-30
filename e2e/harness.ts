import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { _electron as electron, type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";

interface LaunchOptions {
  data?: string;
  env?: Record<string, string>;
  prefs?: Record<string, string>;
}

export const gitIn =
  (dir: string) =>
  (...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });

export function configure(dir: string) {
  const git = gitIn(dir);
  git("config", "user.email", "e2e@example.com");
  git("config", "user.name", "e2e");
  git("config", "commit.gpgsign", "false");
}

export function png(width: number, height: number, [r, g, b]: number[]) {
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

// Call once at the top of a spec. git, shot, clipboard and idle act on the first repo made and the app launched last.
export function harness() {
  const dirs: string[] = [];
  const errors: string[] = [];
  const running = new Set<ElectronApplication>();
  let repo: string;
  let data: string;
  let app: ElectronApplication;
  let page: Page;

  const tmp = (name: string) => {
    const dir = mkdtempSync(join(tmpdir(), `moire-e2e-${name}-`));
    dirs.push(dir);
    return dir;
  };

  const userData = () => (data ??= tmp("data"));

  const initRepo = (dir = tmp("repo")) => {
    mkdirSync(dir, { recursive: true });
    gitIn(dir)("init", "-q", "-b", "main");
    configure(dir);
    repo ??= dir;
    return dir;
  };

  const launch = async (args: string | string[] = [], { data = userData(), env, prefs }: LaunchOptions = {}) => {
    app = await electron.launch({
      args: [resolve("."), `--user-data-dir=${data}`, ...[args].flat()],
      env: { ...process.env, MOIRE_HIDDEN: "1", MOIRE_REPO: "", ...(prefs && { MOIRE_PREFS: JSON.stringify(prefs) }), ...env },
    });
    const launched = app;
    running.add(launched);
    launched.on("close", () => running.delete(launched));
    page = await launched.firstWindow();
    page.on("pageerror", (e) => errors.push(e.message));
    return { app: launched, page };
  };

  const launchAgain = (...args: string[]): Promise<number | null> => {
    const child = spawn(app.process().spawnfile, [resolve("."), `--user-data-dir=${userData()}`, ...args], {
      cwd: repo,
      env: { ...process.env, MOIRE_HIDDEN: "1", MOIRE_REPO: "" },
      stdio: "ignore",
    });
    return new Promise((done) => child.on("exit", done));
  };

  const git = (...args: string[]) => gitIn(repo)(...args);

  const shot = async (name: string, target: Page | Locator = page) => {
    const dir = process.env.MOIRE_SHOTS;
    // Chromium sometimes refuses to capture a hidden window that hasn't painted yet.
    if (dir) await expect(() => target.screenshot({ path: join(dir, `${name}.png`) })).toPass({ timeout: 5000 });
  };

  const shots = async (name: string, target: Page | Locator = page) => {
    if (!process.env.MOIRE_SHOTS) return;
    const html = page.locator("html");
    const tone = await html.getAttribute("data-tone");
    await shot(`${name}-${tone}`, target);
    await page.keyboard.press("t");
    await expect(html).not.toHaveAttribute("data-tone", tone!);
    await shot(`${name}-${tone === "light" ? "dark" : "light"}`, target);
    await page.keyboard.press("t");
    await expect(html).toHaveAttribute("data-tone", tone!);
  };

  // The previous file stays on screen until the new one is ready, so a bare click races whatever comes next.
  const open = async (path: string) => {
    await page.locator(`.file[data-path$="${path}"]`).click();
    await expect(page.locator(`.pane-h b[data-tip$="${path}"]`).first()).toBeVisible();
  };

  const clipboard = () => app.evaluate(({ clipboard }) => clipboard.readText());
  const idle = () => expect(page.locator(".app")).toHaveAttribute("aria-busy", "false");

  test.afterEach(() => {
    expect(errors).toEqual([]);
  });

  test.afterAll(async () => {
    await Promise.all([...running].map((a) => a.close()));
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  return { clipboard, git, idle, initRepo, launch, launchAgain, open, shot, shots, tmp, userData };
}
