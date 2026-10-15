import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openRefusal } from "./open";
import { dirs } from "./test-repo";

function folder() {
  const dir = mkdtempSync(join(tmpdir(), "moire-open-"));
  dirs.push(dir);
  return dir;
}

describe("openRefusal", () => {
  it("lets documents through", () => {
    const dir = folder();
    writeFileSync(join(dir, "page.html"), "<h1>hi</h1>");
    expect(openRefusal(join(dir, "page.html"))).toBeNull();
  });

  it("refuses files the desktop would run", () => {
    const dir = folder();
    writeFileSync(join(dir, "Launch.DESKTOP"), "[Desktop Entry]\n");
    writeFileSync(join(dir, "build"), "#!/bin/sh\n");
    chmodSync(join(dir, "build"), 0o755);
    mkdirSync(join(dir, "Tool.app"));
    expect(openRefusal(join(dir, "Launch.DESKTOP"))).toMatch(/could run as a program/);
    expect(openRefusal(join(dir, "Tool.app"))).toMatch(/could run as a program/);
    if (process.platform !== "win32") expect(openRefusal(join(dir, "build"))).toMatch(/is executable/);
  });

  it("lets executable documents through, as on exFAT or NTFS mounts", () => {
    const dir = folder();
    writeFileSync(join(dir, "notes.md"), "# notes\n");
    writeFileSync(join(dir, "tool.md"), "#!/bin/sh\n");
    writeFileSync(join(dir, "Makefile"), "all:\n");
    for (const name of ["notes.md", "tool.md", "Makefile"]) chmodSync(join(dir, name), 0o755);
    expect(openRefusal(join(dir, "notes.md"))).toBeNull();
    if (process.platform === "win32") return;
    expect(openRefusal(join(dir, "tool.md"))).toMatch(/is executable/);
    expect(openRefusal(join(dir, "Makefile"))).toMatch(/is executable/);
  });

  it("refuses Windows programs whatever they're called", () => {
    const dir = folder();
    writeFileSync(join(dir, "payload.dat"), "MZ\x90\x00");
    expect(openRefusal(join(dir, "payload.dat"))).toMatch(/could run as a program/);
  });

  it("follows symlinks to what they point at", () => {
    const dir = folder();
    writeFileSync(join(dir, "run.sh"), "#!/bin/sh\n");
    symlinkSync(join(dir, "run.sh"), join(dir, "notes.html"));
    expect(openRefusal(join(dir, "notes.html"))).toMatch(/could run as a program/);
    expect(openRefusal(join(dir, "gone.html"))).toMatch(/isn't on disk/);
  });
});
