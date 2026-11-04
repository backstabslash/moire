import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assetName,
  binScript,
  desktopEntry,
  installedPaths,
  launchCommand,
  linuxPaths,
  macShim,
  newer,
  parseArgs,
  releaseError,
  releaseHeaders,
  shortcutScript,
  windowsPaths,
  windowsShims,
} from "./install.mjs";

const WIN = process.platform === "win32";

describe("newer", () => {
  it("compares each part as a number", () => {
    expect(newer("0.10.0", "0.9.3")).toBe(true);
    expect(newer("0.9.3", "0.10.0")).toBe(false);
    expect(newer("1.0.0", "1.0.0")).toBe(false);
  });
});

describe("assetName", () => {
  it("matches the files electron-builder names", () => {
    expect(assetName("linux", "x64", "0.2.0")).toBe("moire-0.2.0.tar.gz");
    expect(assetName("linux", "arm64", "0.2.0")).toBe("moire-0.2.0-arm64.tar.gz");
    expect(assetName("darwin", "x64", "0.2.0")).toBe("moire-0.2.0-mac.zip");
    expect(assetName("darwin", "arm64", "0.2.0")).toBe("moire-0.2.0-arm64-mac.zip");
    expect(assetName("win32", "x64", "0.2.0")).toBe("moire-0.2.0-win.zip");
    expect(assetName("win32", "arm64", "0.2.0")).toBe("moire-0.2.0-arm64-win.zip");
    expect(assetName("freebsd", "x64", "0.2.0")).toBeUndefined();
  });
});

describe("windows install", () => {
  it("installs under LocalAppData with a Start menu shortcut, and keeps settings in AppData", () => {
    const env = { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local", APPDATA: "D:\\Roaming" };
    expect(windowsPaths(env, "C:\\Users\\u")).toEqual({
      root: "C:\\Users\\u\\AppData\\Local\\moire",
      shortcut: "D:\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Moire.lnk",
      data: "D:\\Roaming\\moire",
      bin: "C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps",
      bins: ["C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\moire.cmd", "C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\moire"],
    });
    expect(windowsPaths({}, "C:\\Users\\u").root).toBe("C:\\Users\\u\\AppData\\Local\\moire");
    expect(installedPaths("win32", env, "C:\\Users\\u")).toEqual({
      remove: ["C:\\Users\\u\\AppData\\Local\\moire", "D:\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Moire.lnk"],
      bins: ["C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\moire.cmd", "C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\moire"],
      owner: "C:\\Users\\u\\AppData\\Local\\moire",
      data: "D:\\Roaming\\moire",
    });
  });

  it("opens the current version's exe, and quotes the shortcut's paths for PowerShell", () => {
    const env = { LOCALAPPDATA: "C:\\L" };
    expect(launchCommand("win32", "C:\\Users\\u", env, false, "C:\\r", ["pr", "1"])).toEqual({
      cmd: "C:\\L\\moire\\current\\moire.exe",
      args: ["C:\\r", "pr", "1"],
    });
    expect(shortcutScript("C:\\it's\\Moire.lnk", "C:\\L\\moire.exe")).toBe(
      "$s = (New-Object -ComObject WScript.Shell).CreateShortcut('C:\\it''s\\Moire.lnk'); $s.TargetPath = 'C:\\L\\moire.exe'; $s.Save()",
    );
  });

  it("writes a moire command for cmd and Git Bash that opens current without waiting", () => {
    const [cmd, sh] = windowsShims("C:\\Users\\a%b\\moire");
    expect(cmd).toBe('@echo off\r\nstart "" "C:\\Users\\a%%b\\moire\\current\\moire.exe" %*\r\n');
    expect(sh).toBe('#!/bin/sh\n"C:/Users/a%b/moire/current/moire.exe" "$@" >/dev/null 2>&1 &\n');
  });
});

describe("linux install", () => {
  it.skipIf(WIN)("follows XDG_DATA_HOME", () => {
    expect(linuxPaths({}, "/home/u").root).toBe("/home/u/.local/share/moire");
    expect(linuxPaths({ XDG_DATA_HOME: "/data" }, "/home/u").desktop).toBe("/data/applications/moire.desktop");
  });

  it.skipIf(WIN)("points the desktop entry and command at the current version", () => {
    const entry = desktopEntry("/home/u/.local/share/moire", false);
    expect(entry).toContain('Exec="/home/u/.local/share/moire/current/moire" %U');
    expect(entry).toContain("Name=Moire");
    expect(entry).toContain("StartupWMClass=moire");
    expect(binScript("/home/u/.local/share/moire", true)).toContain('exec "/home/u/.local/share/moire/current/moire" --no-sandbox "$@"');
  });

  it.skipIf(WIN)("quotes paths with shell characters", () => {
    const odd = '/a "$b`c\\d/moire';
    const quoted = '"/a \\"\\$b\\`c\\\\d/moire/current/moire"';
    expect(desktopEntry(odd, false)).toContain(`Exec=${quoted} %U`);
    expect(binScript(odd, false)).toContain(`exec ${quoted} "$@"`);
  });
});

describe("parseArgs", () => {
  it("separates the path from flags and catches unknown ones", () => {
    expect(parseArgs(["../repo", "--no-sandbox"])).toMatchObject({ path: "../repo", noSandbox: true, unknown: undefined });
    expect(parseArgs(["-h"])).toMatchObject({ help: true, path: undefined });
    expect(parseArgs(["--version", "--uninstall"])).toMatchObject({ version: true, uninstall: true });
    expect(parseArgs(["--verbose", "."]).unknown).toBe("--verbose");
  });

  it("separates a path from a comparison, leaving comparisons unresolved", () => {
    const none = () => false;
    expect(parseArgs(["main..feature"], none)).toMatchObject({ path: undefined, compare: ["main..feature"] });
    expect(parseArgs(["../repo", "HEAD~3"], none)).toMatchObject({ path: "../repo", compare: ["HEAD~3"] });
    expect(parseArgs(["pr", "123", "--no-sandbox"], () => true)).toMatchObject({ path: undefined, compare: ["pr", "123"], noSandbox: true });
    expect(parseArgs(["main"], () => true)).toMatchObject({ path: "main", compare: [] });
    expect(parseArgs([".\\repo", "HEAD~3"], none)).toMatchObject({ path: ".\\repo", compare: ["HEAD~3"] });
    expect(parseArgs(["C:\\work\\repo"], none)).toMatchObject({ path: "C:\\work\\repo", compare: [] });
  });
});

describe("GitHub requests", () => {
  const api = "https://api.github.com/repos/backstabslash/moire/releases/latest";

  it("sends GITHUB_TOKEN only to GitHub's API", () => {
    expect(releaseHeaders({ GITHUB_TOKEN: "t" }, api).Authorization).toBe("Bearer t");
    expect(releaseHeaders({}, api).Authorization).toBeUndefined();
    expect(releaseHeaders({ GITHUB_TOKEN: "t" }, "http://localhost:8080/latest").Authorization).toBeUndefined();
  });

  it("explains rate limits", () => {
    expect(releaseError(403)).toContain("GITHUB_TOKEN");
    expect(releaseError(429)).toContain("rate limit");
    expect(releaseError(404)).toBe("no release published yet");
    expect(releaseError(500)).toBe("GitHub answered 500");
  });
});

describe("launch and uninstall", () => {
  it.skipIf(WIN)("opens the app with the repo", () => {
    expect(launchCommand("linux", "/home/u", {}, true, "/r")).toEqual({ cmd: "/home/u/.local/share/moire/current/moire", args: ["--no-sandbox", "/r"] });
    expect(launchCommand("darwin", "/Users/u", {}, false, "/r")).toEqual({ cmd: "open", args: ["-na", "/Users/u/Applications/moire.app", "--args", "/r"] });
    expect(launchCommand("linux", "/home/u", {}, false, "/r", ["pr", "1"]).args).toEqual(["/r", "pr", "1"]);
    expect(launchCommand("darwin", "/Users/u", {}, false, "/r", ["a..b"]).args.slice(-2)).toEqual(["/r", "a..b"]);
  });

  describe("the macOS terminal command", () => {
    const opened = (/** @type {string[]} */ args) => {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), "moire-shim-")));
      mkdirSync(join(dir, "bin"));
      mkdirSync(join(dir, "work", "repo"), { recursive: true });
      mkdirSync(join(dir, "work", "pr"));
      writeFileSync(join(dir, "bin", "open"), `#!/bin/sh\nfor a; do echo "$a"; done\n`, { mode: 0o755 });
      writeFileSync(join(dir, "moire"), macShim("/A/moire.app"), { mode: 0o755 });
      const out = execFileSync(join(dir, "moire"), args, { cwd: join(dir, "work"), env: { PATH: `${join(dir, "bin")}:/usr/bin:/bin` }, encoding: "utf8" });
      rmSync(dir, { recursive: true, force: true });
      return out
        .trim()
        .split("\n")
        .slice(3)
        .map((a) => a.replace(join(dir, "work"), "$PWD"));
    };

    it.skipIf(WIN)("always sends an absolute repo first, since open starts the app in /", () => {
      expect(opened([])).toEqual(["$PWD"]);
      expect(opened(["repo"])).toEqual(["$PWD/repo"]);
      expect(opened(["/srv/repo"])).toEqual(["/srv/repo"]);
    });

    it.skipIf(WIN)("passes comparisons on, with or without a path", () => {
      expect(opened(["main..feature"])).toEqual(["$PWD", "main..feature"]);
      expect(opened(["/srv/repo", "HEAD~3"])).toEqual(["/srv/repo", "HEAD~3"]);
      expect(opened(["repo", "pr", "123"])).toEqual(["$PWD/repo", "pr", "123"]);
    });

    it.skipIf(WIN)("reads pr 123 as a pull request even beside a folder called pr", () => {
      expect(opened(["pr", "123"])).toEqual(["$PWD", "pr", "123"]);
      expect(opened(["pr"])).toEqual(["$PWD/pr"]);
    });
  });

  it.skipIf(WIN)("lists what install put in the home folder, and where settings live", () => {
    expect(installedPaths("linux", {}, "/home/u")).toEqual({
      remove: ["/home/u/.local/share/moire", "/home/u/.local/share/applications/moire.desktop"],
      bins: ["/home/u/.local/bin/moire"],
      owner: "/home/u/.local/share/moire",
      data: "/home/u/.config/moire",
    });
    const mac = installedPaths("darwin", {}, "/Users/u");
    expect(mac.remove).toEqual(["/Users/u/Applications/moire.app", "/Users/u/Applications/.moire-previous.app"]);
    expect(mac.data).toBe("/Users/u/Library/Application Support/moire");
  });
});
