import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isLaunchRequest, launchRequest, loginPath, markedPath, mergePath, tildify, usableCwd } from "./launch";
import { dirs } from "./test-repo";

describe("launchRequest", () => {
  it("takes the first path argument, relative to the caller's folder", () => {
    expect(launchRequest(["/opt/moire/moire", "--no-sandbox", "../x"], "/home/u/a", true)).toEqual({ path: "/home/u/x", cwd: "/home/u/a" });
    expect(launchRequest(["/opt/moire/moire", "/srv/repo"], "/", true)).toEqual({ path: "/srv/repo", cwd: "/" });
    expect(launchRequest(["/opt/moire/moire", "--no-sandbox"], "/home/u", true)).toEqual({ cwd: "/home/u" });
  });

  it("skips the app folder in dev", () => {
    expect(launchRequest(["electron", "/src/moire", "--user-data-dir=/tmp/d", "/srv/repo"], "/src/moire", false)).toEqual({
      path: "/srv/repo",
      cwd: "/src/moire",
    });
    expect(launchRequest(["electron", "."], "/src/moire", false)).toEqual({ cwd: "/src/moire" });
  });

  it("recognises a request passed from another instance", () => {
    expect(isLaunchRequest({ cwd: "/a" })).toBe(true);
    expect(isLaunchRequest({ path: "/a/b", cwd: "/a" })).toBe(true);
    expect(isLaunchRequest({ path: 1, cwd: "/a" })).toBe(false);
    expect(isLaunchRequest(null)).toBe(false);
  });
});

describe("paths", () => {
  it("ignores the folders desktop launchers start in", () => {
    expect(usableCwd("/", "/home/u")).toBeUndefined();
    expect(usableCwd("/home/u", "/home/u")).toBeUndefined();
    expect(usableCwd("/home/u/code", "/home/u")).toBe("/home/u/code");
  });

  it("shortens the home folder", () => {
    expect(tildify("/home/u/x", "/home/u")).toBe("~/x");
    expect(tildify("/home/u", "/home/u")).toBe("~");
    expect(tildify("/home/uv/x", "/home/u")).toBe("/home/uv/x");
  });

  it("merges PATHs without repeats", () => {
    expect(mergePath("/a:/b", "/b:/c::")).toBe("/a:/b:/c");
  });
});

describe("loginPath", () => {
  const fakeShell = (body: string) => {
    const dir = mkdtempSync(join(tmpdir(), "moire-shell-"));
    dirs.push(dir);
    writeFileSync(join(dir, "sh"), `#!/bin/sh\n${body}\n`);
    chmodSync(join(dir, "sh"), 0o755);
    return join(dir, "sh");
  };

  it("reads PATH between the markers, ignoring what rc files print", async () => {
    const shell = fakeShell('echo "welcome back"; PATH=/opt/x:/usr/bin; eval "$2"');
    expect(await loginPath(shell, 5000)).toBe("/opt/x:/usr/bin");
  });

  it("gives up on a shell that doesn't finish", async () => {
    expect(await loginPath(fakeShell("sleep 10"), 100)).toBeNull();
    expect(await loginPath("/nonexistent/shell", 1000)).toBeNull();
  });

  it("needs both markers", () => {
    expect(markedPath("__moire_path__ /usr/bin")).toBeNull();
    expect(markedPath("hi\n__moire_path__ /usr/bin __moire_path__\n")).toBe("/usr/bin");
  });
});
