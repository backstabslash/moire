import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";

export interface LaunchRequest {
  path?: string;
  cwd: string;
}

// In dev, argv[1] is the app folder that electron was started with.
export function launchRequest(argv: string[], cwd: string, packaged: boolean): LaunchRequest {
  const arg = argv.slice(packaged ? 1 : 2).find((a) => !a.startsWith("-"));
  return arg ? { path: resolve(cwd, arg), cwd } : { cwd };
}

export function isLaunchRequest(data: unknown): data is LaunchRequest {
  const d = data as LaunchRequest | null;
  return typeof d?.cwd === "string" && (d.path === undefined || typeof d.path === "string");
}

// Desktop launchers start apps in the home folder, which may be a dotfiles repo.
export function usableCwd(cwd: string, home = homedir()): string | undefined {
  return cwd === "/" || cwd === home ? undefined : cwd;
}

export function tildify(path: string, home = homedir()): string {
  if (path === home) return "~";
  return path.startsWith(home + "/") ? `~${path.slice(home.length)}` : path;
}

export function mergePath(first: string, second: string, delimiter = ":"): string {
  return [...new Set([...first.split(delimiter), ...second.split(delimiter)].filter(Boolean))].join(delimiter);
}

const MARK = "__moire_path__";

export function markedPath(out: string): string | null {
  const parts = out.split(MARK);
  return parts.length >= 3 && parts[1].trim() ? parts[1].trim() : null;
}

// Interactive too, since version managers such as nvm are set up in .zshrc or .bashrc.
export function loginPath(shell: string, timeout: number): Promise<string | null> {
  return new Promise((done) => {
    let out = "";
    const child = spawn(shell, ["-ilc", `echo ${MARK} "$PATH" ${MARK}`], { stdio: ["ignore", "pipe", "ignore"] });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done(markedPath(out));
    }, timeout);
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.on("error", () => done(null));
    child.on("close", () => {
      clearTimeout(timer);
      done(markedPath(out));
    });
  });
}
