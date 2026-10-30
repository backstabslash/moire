import { spawn } from "node:child_process";
import { accessSync, constants, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, isAbsolute, join } from "node:path";
import type { EditorChoice, EditorChoices } from "../shared/types";

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

const TERMINAL_EDITORS: [string, string][] = [
  ["nvim", "+{line} {file}"],
  ["vim", "+{line} {file}"],
  ["vi", "+{line} {file}"],
  ["hx", "{file}:{line}"],
  ["micro", "+{line} {file}"],
  ["kak", "+{line} {file}"],
  ["nano", "+{line} {file}"],
];

const TERMINALS: [string, string[]][] = [
  ["x-terminal-emulator", ["-e"]],
  ["ptyxis", ["--"]],
  ["gnome-terminal", ["--"]],
  ["konsole", ["-e"]],
  ["ghostty", ["-e"]],
  ["kitty", []],
  ["alacritty", ["-e"]],
  ["wezterm", ["start", "--"]],
  ["foot", []],
  ["xfce4-terminal", ["-x"]],
  ["xterm", ["-e"]],
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

function fromTemplate(template: string, path?: string): { exe: string; args: string[] } | null {
  const [name, ...args] = template.trim().split(/\s+/);
  const exe = findExecutable(name, path);
  return exe ? { exe, args } : null;
}

export function resolveEditor(saved: string | undefined, path?: string): { exe: string; args: string[] } | null {
  const template = process.env.MOIRE_EDITOR || saved;
  if (template) return fromTemplate(template, path);
  for (const [name, args] of KNOWN) {
    const exe = findExecutable(name, path);
    if (exe) return { exe, args: args.split(" ") };
  }
  return null;
}

export const needsTerminal = (exe: string) => TERMINAL_EDITORS.some(([name]) => name === basename(exe));

const shellQuote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
const appleQuote = (text: string) => `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

function findTerminal(path?: string): { exe: string; prefix: string[] } | null {
  for (const [name, prefix] of TERMINALS) {
    const exe = findExecutable(name, path);
    if (exe) return { exe, prefix };
  }
  return null;
}

// AppleScript and older Ghostty run their command through a shell, so only this script's path passes through a terminal, never a file name.
function openScript(exe: string, args: string[], cwd: string): string {
  const dir = mkdtempSync(join(tmpdir(), "moire-editor-"));
  const script = join(dir, "open.sh");
  writeFileSync(script, `rm -rf -- ${shellQuote(dir)}\ncd -- ${shellQuote(cwd)}\nexec ${[exe, ...args].map(shellQuote).join(" ")}\n`);
  return script;
}

// With no terminal attached, nvim and the like exit at once and nothing appears.
export function inTerminal(exe: string, args: string[], cwd: string, platform = process.platform, path?: string): { exe: string; args: string[] } | null {
  if (platform === "darwin") {
    const command = `sh ${shellQuote(openScript(exe, args, cwd))}`;
    return {
      exe: "osascript",
      args: ["-e", `tell application "Terminal" to do script ${appleQuote(command)}`, "-e", 'tell application "Terminal" to activate'],
    };
  }
  const terminal = findTerminal(path);
  return terminal && { exe: terminal.exe, args: [...terminal.prefix, "sh", openScript(exe, args, cwd)] };
}

const noTerminal = (name: string) => new Error(`${name} needs a terminal, and moire couldn't find one`);

const SETTLE_MS = 500;

// Editors stay running, so failure is an early exit; osascript always exits, after macOS's permission prompt.
export function launch(exe: string, args: string[], cwd: string, settleMs = SETTLE_MS): Promise<void> {
  const name = basename(exe);
  const mac = name === "osascript";
  return new Promise((done, fail) => {
    const child = spawn(exe, args, { cwd, detached: true, stdio: "ignore" });
    const timer = mac ? undefined : setTimeout(done, settleMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      fail(e);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (!code) return done();
      fail(
        new Error(
          mac ? "macOS didn't let moire open Terminal. Allow it in System Settings, Privacy & Security, Automation." : `${name} exited with code ${code}`,
        ),
      );
    });
    child.unref();
  });
}

export async function openInEditor(root: string, path: string, line: number, saved: string | undefined): Promise<string | null> {
  const editor = resolveEditor(saved);
  if (!editor) return null;
  const name = basename(editor.exe);
  const file = join(root, path);
  const args = editor.args.map((a) => a.replaceAll("{file}", file).replaceAll("{line}", String(line)));
  const run = needsTerminal(editor.exe) ? inTerminal(editor.exe, args, root) : { exe: editor.exe, args };
  if (!run) throw noTerminal(name);
  await launch(run.exe, run.args, root);
  return name;
}

export function installedEditors(path?: string, platform = process.platform): EditorChoices {
  const choices = (list: [string, string][], terminal: boolean): EditorChoice[] =>
    list.filter(([name]) => findExecutable(name, path)).map(([name, args]) => ({ name, template: `${name} ${args}`, terminal }));
  const terminal = platform === "darwin" || !!findTerminal(path);
  return { installed: [...choices(KNOWN, false), ...(terminal ? choices(TERMINAL_EDITORS, true) : [])], fromEnv: !!process.env.MOIRE_EDITOR };
}

export function chooseEditor(template: string, path?: string, platform = process.platform): { editor: string; name: string } {
  const text = template.trim();
  const editor = text.includes("{file}") ? text : `${text} {file}`;
  const found = fromTemplate(editor, path);
  if (!found) throw new Error(`Can't find ${text.split(/\s+/)[0]}`);
  const name = basename(found.exe);
  if (needsTerminal(found.exe) && platform !== "darwin" && !findTerminal(path)) throw noTerminal(name);
  return { editor, name };
}
