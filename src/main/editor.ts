import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, isAbsolute, join } from "node:path";

const KNOWN: [string, string][] = [
  ["cursor", "-g {file}:{line}"],
  ["code", "-g {file}:{line}"],
  ["codium", "-g {file}:{line}"],
  ["zed", "{file}:{line}"],
  ["subl", "{file}:{line}"],
  ["idea", "--line {line} {file}"],
  ["webstorm", "--line {line} {file}"],
  ["pycharm", "--line {line} {file}"],
  ["goland", "--line {line} {file}"],
  ["rustrover", "--line {line} {file}"],
];

const MAC_APPS: Record<string, string> = {
  cursor: "/Applications/Cursor.app/Contents/Resources/app/bin/cursor",
  code: "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
  zed: "/Applications/Zed.app/Contents/MacOS/cli",
  subl: "/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl",
};

function executable(path: string) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Apps started from a desktop launcher often get a shorter PATH than a terminal, so common install folders are searched too.
export function findExecutable(name: string, path?: string): string | null {
  if (isAbsolute(name)) return executable(name) ? name : null;
  const dirs = path?.split(delimiter) ?? [
    ...(process.env.PATH ?? "").split(delimiter),
    join(homedir(), ".local", "bin"),
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/snap/bin",
  ];
  for (const dir of dirs.filter(Boolean)) {
    if (executable(join(dir, name))) return join(dir, name);
  }
  const app = path === undefined && process.platform === "darwin" ? MAC_APPS[name] : undefined;
  return app && executable(app) ? app : null;
}

export function resolveEditor(saved: string | undefined, path?: string): { exe: string; args: string[] } | null {
  const template = process.env.MOIRE_EDITOR || saved;
  if (template) {
    const [name, ...args] = template.trim().split(/\s+/);
    const exe = findExecutable(name, path);
    return exe ? { exe, args } : null;
  }
  for (const [name, args] of KNOWN) {
    const exe = findExecutable(name, path);
    if (exe) return { exe, args: args.split(" ") };
  }
  return null;
}

export function openInEditor(root: string, path: string, line: number, saved: string | undefined): string {
  const editor = resolveEditor(saved);
  if (!editor) throw new Error("No editor found. Set MOIRE_EDITOR to a command such as: code -g {file}:{line}");
  const file = join(root, path);
  const args = editor.args.map((a) => a.replaceAll("{file}", file).replaceAll("{line}", String(line)));
  const child = spawn(editor.exe, args, { cwd: root, detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
  return basename(editor.exe);
}
