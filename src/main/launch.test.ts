import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { isLaunchRequest, launchRequest, loginPath, markedPath, mergePath, tildify, usableCwd } from "./launch";
import { tempDir, WIN } from "./test-repo";

describe("launchRequest", () => {
  it.skipIf(WIN)("takes the first path argument, relative to the caller's folder", () => {
    expect(launchRequest(["/opt/moire/moire", "--no-sandbox", "../x"], "/home/u/a", true)).toEqual({ path: "/home/u/x", cwd: "/home/u/a" });
    expect(launchRequest(["/opt/moire/moire", "/srv/repo"], "/", true)).toEqual({ path: "/srv/repo", cwd: "/" });
    expect(launchRequest(["/opt/moire/moire", "--no-sandbox"], "/home/u", true)).toEqual({ cwd: "/home/u" });
  });

  it.runIf(WIN)("reads drive and backslash paths as paths", () => {
    const none = () => false;
    expect(launchRequest(["moire", "D:\\repo", "HEAD~3"], "C:\\r", true, none)).toEqual({ path: "D:\\repo", compare: ["HEAD~3"], cwd: "C:\\r" });
    expect(launchRequest(["moire", ".\\repo"], "C:\\r", true, none).path).toBe("C:\\r\\repo");
  });

  it.skipIf(WIN)("skips the app folder in dev", () => {
    expect(launchRequest(["electron", "/src/moire", "--user-data-dir=/tmp/d", "/srv/repo"], "/src/moire", false)).toEqual({
      path: "/srv/repo",
      cwd: "/src/moire",
    });
    expect(launchRequest(["electron", "."], "/src/moire", false)).toEqual({ cwd: "/src/moire" });
  });

  it.skipIf(WIN)("tells a comparison from a path by what's on disk, and paths win", () => {
    const none = () => false;
    expect(launchRequest(["moire", "main..feature"], "/r", true, none)).toEqual({ compare: ["main..feature"], cwd: "/r" });
    expect(launchRequest(["moire", "/srv/repo", "HEAD~3"], "/r", true, none)).toEqual({ path: "/srv/repo", compare: ["HEAD~3"], cwd: "/r" });
    expect(launchRequest(["moire", "main"], "/r", true, (p) => p === "/r/main")).toEqual({ path: "/r/main", cwd: "/r" });
    expect(launchRequest(["moire", "main"], "/r", true, none)).toEqual({ compare: ["main"], cwd: "/r" });
    expect(launchRequest(["moire", "..feature"], "/r", true, none)).toEqual({ compare: ["..feature"], cwd: "/r" });
    expect(launchRequest(["moire", "pr", "123"], "/r", true, () => true)).toEqual({ compare: ["pr", "123"], cwd: "/r" });
    expect(launchRequest(["moire", "./pr", "HEAD~1"], "/r", true, () => true)).toEqual({ path: "/r/pr", compare: ["HEAD~1"], cwd: "/r" });
  });

  it("recognises a request passed from another instance", () => {
    expect(isLaunchRequest({ cwd: "/a" })).toBe(true);
    expect(isLaunchRequest({ path: "/a/b", cwd: "/a" })).toBe(true);
    expect(isLaunchRequest({ compare: ["pr", "1"], cwd: "/a" })).toBe(true);
    expect(isLaunchRequest({ path: 1, cwd: "/a" })).toBe(false);
    expect(isLaunchRequest({ compare: "main", cwd: "/a" })).toBe(false);
    expect(isLaunchRequest(null)).toBe(false);
  });
});

describe("paths", () => {
  it("ignores the folders desktop launchers start in", () => {
    expect(usableCwd("/", "/home/u")).toBeUndefined();
    expect(usableCwd("/home/u", "/home/u")).toBeUndefined();
    expect(usableCwd("/home/u/code", "/home/u")).toBe("/home/u/code");
  });

  it("ignores a Windows drive root, System32 and the app's own folder", () => {
    const dirs = ["D:\\apps\\moire", "C:\\Windows"];
    expect(usableCwd("C:\\", "C:\\Users\\u", dirs)).toBeUndefined();
    expect(usableCwd("C:\\WINDOWS\\system32", "C:\\Users\\u", dirs)).toBeUndefined();
    expect(usableCwd("d:\\Apps\\moire", "C:\\Users\\u", dirs)).toBeUndefined();
    expect(usableCwd("D:\\apps\\moire-repo", "C:\\Users\\u", dirs)).toBe("D:\\apps\\moire-repo");
  });

  it("shortens the home folder", () => {
    expect(tildify("/home/u/x", "/home/u")).toBe("~/x");
    expect(tildify("/home/u", "/home/u")).toBe("~");
    expect(tildify("/home/uv/x", "/home/u")).toBe("/home/uv/x");
  });

  it.skipIf(WIN)("knows the home folder by its real path too, where /home is a link", () => {
    const dir = tempDir("moire-home-");
    mkdirSync(join(dir, "var-home"));
    symlinkSync(join(dir, "var-home"), join(dir, "home"));
    expect(usableCwd(join(dir, "var-home"), join(dir, "home"))).toBeUndefined();
    expect(tildify(join(dir, "var-home", "x"), join(dir, "home"))).toBe("~/x");
  });

  it("merges PATHs without repeats", () => {
    expect(mergePath("/a:/b", "/b:/c::")).toBe("/a:/b:/c");
  });
});

describe("loginPath", () => {
  const fakeShell = (body: string) => {
    const dir = tempDir("moire-shell-");
    writeFileSync(join(dir, "sh"), `#!/bin/sh\n${body}\n`);
    chmodSync(join(dir, "sh"), 0o755);
    return join(dir, "sh");
  };

  it.skipIf(WIN)("reads PATH between the markers, ignoring what rc files print", async () => {
    const shell = fakeShell('echo "welcome back"; PATH=/opt/x:/usr/bin; eval "$2"');
    expect(await loginPath(shell, 5000)).toBe("/opt/x:/usr/bin");
  });

  it.skipIf(WIN)("gives up on a shell that doesn't finish, and kills it", async () => {
    const dir = tempDir("moire-pid-");
    expect(await loginPath(fakeShell(`echo $$ > ${dir}/pid; exec sleep 10`), 500)).toBeNull();
    const pid = Number(readFileSync(join(dir, "pid"), "utf8"));
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow("ESRCH"));
    expect(await loginPath("/nonexistent/shell", 1000)).toBeNull();
  });

  it("needs both markers", () => {
    expect(markedPath("__moire_path__ /usr/bin")).toBeNull();
    expect(markedPath("hi\n__moire_path__ /usr/bin __moire_path__\n")).toBe("/usr/bin");
  });
});
