import { describe, expect, it } from "vitest";
import { assetName, binScript, desktopEntry, linuxPaths, newer } from "./install.mjs";

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
    expect(entry).toContain("StartupWMClass=moire");
    expect(binScript("/home/u/.local/share/moire", true)).toContain('exec "/home/u/.local/share/moire/current/moire" --no-sandbox "$@"');
  });

  it("quotes paths with shell characters", () => {
    expect(desktopEntry('/home/a "b"/moire', false)).toContain('Exec="/home/a \\"b\\"/moire/current/moire" %U');
  });
});
