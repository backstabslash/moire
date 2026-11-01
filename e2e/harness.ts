import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { _electron as electron, type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test";

interface LaunchOptions {
  data?: string;
  env?: Record<string, string>;
  prefs?: Record<string, string>;
  systemClipboard?: boolean;
}

export const gitIn =
  (dir: string) =>
  (...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });

export const commitAllIn = (dir: string) => (message: string) => {
  const git = gitIn(dir);
  git("add", "-A");
  git("commit", "-qm", message);
};

export const writeIn = (dir: string) => (path: string, text: string | Buffer) => {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
};

export function configure(dir: string) {
  const git = gitIn(dir);
  git("config", "user.email", "e2e@example.com");
  git("config", "user.name", "e2e");
  git("config", "commit.gpgsign", "false");
}

export const writeNotes = (repo: string, notes: unknown) => {
  mkdirSync(join(repo, ".git", "moire"), { recursive: true });
  writeFileSync(join(repo, ".git", "moire", "notes.json"), JSON.stringify({ format: 2, ...(notes as object) }));
};

export const writeCommitNotes = (repo: string, sha: string, notes: unknown) => {
  mkdirSync(join(repo, ".git", "moire", "commits"), { recursive: true });
  writeFileSync(join(repo, ".git", "moire", "commits", `${sha}.json`), JSON.stringify({ format: 2, ...(notes as object) }));
};

export const staged = (repo: string) => gitIn(repo)("diff", "--cached", "--name-only").trim().split("\n").filter(Boolean);

export const lines = (list: string[]) => list.join("\n") + "\n";

export const numbered = (length: number) => {
  const body = Array.from({ length }, (_, i) => `export const v${i} = ${i};`);
  return { body, edit: (...at: number[]) => body.map((l, i) => (at.includes(i) ? l.replace(`= ${i}`, `= ${i}0`) : l)) };
};

const NAMES = ["a", "b", "c", "d", "e"];
export const fileChapters = NAMES.map((name) => ({ title: `Chapter ${name}`, text: "Why.", ranges: [`${name}.ts`] }));

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

// Call once at the top of a spec. git and the helpers it returns act on the first repo made and the app launched last.
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

  const cleanRepo = () => {
    const repo = initRepo();
    for (const name of NAMES) writeFileSync(join(repo, `${name}.ts`), `export const ${name} = 1;\n`);
    commitAllIn(repo)("init");
    return repo;
  };

  const changedRepo = (notes: unknown) => {
    const repo = cleanRepo();
    for (const name of NAMES) writeFileSync(join(repo, `${name}.ts`), `export const ${name} = 2;\n`);
    writeNotes(repo, notes);
    return repo;
  };

  const editedRepo = (files: Record<string, [before: string | Buffer, after: string | Buffer]>, notes: unknown) => {
    const repo = initRepo();
    const write = writeIn(repo);
    for (const [path, [before]] of Object.entries(files)) write(path, before);
    commitAllIn(repo)("init");
    for (const [path, [, after]] of Object.entries(files)) write(path, after);
    writeNotes(repo, notes);
    return repo;
  };

  const launch = async (args: string | string[] = [], { data = userData(), env, prefs, systemClipboard }: LaunchOptions = {}) => {
    app = await electron.launch({
      args: [resolve("."), `--user-data-dir=${data}`, ...[args].flat()],
      env: { ...process.env, MOIRE_HIDDEN: "1", MOIRE_REPO: "", ...(prefs && { MOIRE_PREFS: JSON.stringify(prefs) }), ...env },
    });
    const launched = app;
    running.add(launched);
    launched.on("close", () => running.delete(launched));
    // Workers share the system clipboard, so each app keeps its own.
    if (!systemClipboard) {
      await launched.evaluate(({ clipboard }) => {
        let copied = "";
        clipboard.writeText = async (text) => {
          copied = text;
        };
        clipboard.readText = async () => copied;
      });
    }
    page = await launched.firstWindow();
    page.on("pageerror", (e) => errors.push(e.message));
    return { app: launched, page };
  };

  const closeAll = () => Promise.all([...running].map((a) => a.close()));

  const launchFresh = async (args: string | string[], options: Omit<LaunchOptions, "data"> = {}) => {
    await closeAll();
    return launch(args, { ...options, data: tmp("data") });
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
  const commitAll = (message: string) => commitAllIn(repo)(message);

  const html = () => page.locator("html");
  const variable = (name: string) => page.evaluate((name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim(), name);

  const pick = async (name: RegExp) => {
    await page.locator(".theme-btn").click();
    await page.getByRole("menuitemradio", { name }).click();
    await page.keyboard.press("Escape");
  };

  const resize = async (width: number, height: number) => {
    await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setSize(w, h), [width, height]);
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width);
  };

  const shot = async (name: string, target: Page | Locator = page) => {
    const dir = process.env.MOIRE_SHOTS;
    // Chromium sometimes refuses to capture a hidden window that hasn't painted yet.
    if (dir) await expect(() => target.screenshot({ path: join(dir, `${name}.png`) })).toPass({ timeout: 5000 });
  };

  const shots = async (name: string, target: Page | Locator = page) => {
    if (!process.env.MOIRE_SHOTS) return;
    const tone = await html().getAttribute("data-tone");
    await shot(`${name}-${tone}`, target);
    await page.keyboard.press("t");
    await expect(html()).not.toHaveAttribute("data-tone", tone!);
    await shot(`${name}-${tone === "light" ? "dark" : "light"}`, target);
    await page.keyboard.press("t");
    await expect(html()).toHaveAttribute("data-tone", tone!);
  };

  // The previous file stays on screen until the new one is ready, so a bare click races whatever comes next.
  const open = async (path: string) => {
    await page.locator(`.file[data-path$="${path}"]`).click();
    await expect(page.locator(`.pane-h b[data-tip$="${path}"]`).first()).toBeVisible();
  };

  const recordOpens = async () => {
    await app.evaluate(({ shell }) => {
      const opened: string[] = [];
      Object.assign(globalThis, { opened });
      shell.openPath = async (path) => {
        opened.push(path);
        return "";
      };
    });
    return () => app.evaluate(() => (globalThis as unknown as { opened: string[] }).opened);
  };

  const clipboard = () => app.evaluate(({ clipboard }) => clipboard.readText());
  const idle = () => expect(page.locator(".app")).toHaveAttribute("aria-busy", "false");

  test.afterEach(() => {
    expect(errors).toEqual([]);
  });

  test.afterAll(async () => {
    await closeAll();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  return {
    changedRepo,
    cleanRepo,
    clipboard,
    commitAll,
    editedRepo,
    git,
    html,
    idle,
    initRepo,
    launch,
    launchAgain,
    launchFresh,
    open,
    pick,
    recordOpens,
    resize,
    shot,
    shots,
    tmp,
    userData,
    variable,
  };
}
