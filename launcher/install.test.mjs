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
} from "./install.mjs";

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
    expect(assetName("win32", "x64", "0.2.0")).toBeUndefined();
  });
});

describe("linux install", () => {
  it("follows XDG_DATA_HOME", () => {
    expect(linuxPaths({}, "/home/u").root).toBe("/home/u/.local/share/moire");
    expect(linuxPaths({ XDG_DATA_HOME: "/data" }, "/home/u").desktop).toBe("/data/applications/moire.desktop");
  });

  it("points the desktop entry and command at the current version", () => {
    const entry = desktopEntry("/home/u/.local/share/moire", false);
    expect(entry).toContain('Exec="/home/u/.local/share/moire/current/moire" %U');
    expect(entry).toContain("Name=Moire");
    expect(entry).toContain("StartupWMClass=moire");
    expect(binScript("/home/u/.local/share/moire", true)).toContain('exec "/home/u/.local/share/moire/current/moire" --no-sandbox "$@"');
  });

  it("quotes paths with shell characters", () => {
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
  it("opens the app with the repo", () => {
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

    it("always sends an absolute repo first, since open starts the app in /", () => {
      expect(opened([])).toEqual(["$PWD"]);
      expect(opened(["repo"])).toEqual(["$PWD/repo"]);
      expect(opened(["/srv/repo"])).toEqual(["/srv/repo"]);
    });

    it("passes comparisons on, with or without a path", () => {
      expect(opened(["main..feature"])).toEqual(["$PWD", "main..feature"]);
      expect(opened(["/srv/repo", "HEAD~3"])).toEqual(["/srv/repo", "HEAD~3"]);
      expect(opened(["repo", "pr", "123"])).toEqual(["$PWD/repo", "pr", "123"]);
    });

    it("reads pr 123 as a pull request even beside a folder called pr", () => {
      expect(opened(["pr", "123"])).toEqual(["$PWD", "pr", "123"]);
      expect(opened(["pr"])).toEqual(["$PWD/pr"]);
    });
  });

  it("lists what install put in the home folder, and where settings live", () => {
    expect(installedPaths("linux", {}, "/home/u")).toEqual({
      remove: ["/home/u/.local/share/moire", "/home/u/.local/share/applications/moire.desktop"],
      bin: "/home/u/.local/bin/moire",
      owner: "/home/u/.local/share/moire",
      data: "/home/u/.config/moire",
    });
    const mac = installedPaths("darwin", {}, "/Users/u");
    expect(mac.remove).toEqual(["/Users/u/Applications/moire.app", "/Users/u/Applications/.moire-previous.app"]);
    expect(mac.data).toBe("/Users/u/Library/Application Support/moire");
  });
});
