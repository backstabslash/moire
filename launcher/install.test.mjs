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
    expect(desktopEntry('/home/a "b"/moire', false)).toContain('Exec="/home/a \\"b\\"/moire/current/moire" %U');
  });
});

describe("parseArgs", () => {
  it("separates the path from flags and catches unknown ones", () => {
    expect(parseArgs(["../repo", "--no-sandbox"])).toMatchObject({ path: "../repo", noSandbox: true, unknown: undefined });
    expect(parseArgs(["-h"])).toMatchObject({ help: true, path: undefined });
    expect(parseArgs(["--version", "--uninstall"])).toMatchObject({ version: true, uninstall: true });
    expect(parseArgs(["--verbose", "."]).unknown).toBe("--verbose");
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
  });

  it("gives macOS a terminal command that passes an absolute path", () => {
    const shim = macShim("/Users/u/Applications/moire.app");
    expect(shim).toContain('dir="$PWD/${1:-.}"');
    expect(shim).toContain('exec open -na "/Users/u/Applications/moire.app" --args "$dir"');
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
