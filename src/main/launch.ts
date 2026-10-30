import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export interface LaunchRequest {
  path?: string;
  compare?: string[];
  cwd: string;
}

// In dev, argv[1] is the app folder that electron was started with.
export function launchRequest(argv: string[], cwd: string, packaged: boolean, exists = existsSync): LaunchRequest {
  const args = argv.slice(packaged ? 1 : 2).filter((a) => !a.startsWith("-"));
  const pr = args[0] === "pr" && /^\d+$/.test(args[1] ?? "");
  const hasPath = !!args.length && !pr && (/^\.{0,2}\/|^\.{1,2}$/.test(args[0]) || exists(resolve(cwd, args[0])));
  const compare = args.slice(hasPath ? 1 : 0);
  return { ...(hasPath && { path: resolve(cwd, args[0]) }), ...(compare.length && { compare }), cwd };
}

export function isLaunchRequest(data: unknown): data is LaunchRequest {
  const d = data as LaunchRequest | null;
  const compare = d?.compare === undefined || (Array.isArray(d.compare) && d.compare.every((a) => typeof a === "string"));
  return typeof d?.cwd === "string" && (d.path === undefined || typeof d.path === "string") && compare;
}

// Fedora Atomic and others link /home to /var/home, so $HOME and the paths the system reports differ.
export function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

// Desktop launchers start apps in the home folder, which may be a dotfiles repo.
export function usableCwd(cwd: string, home = homedir()): string | undefined {
  return cwd === "/" || cwd === home || cwd === real(home) ? undefined : cwd;
}

export function tildify(path: string, home = homedir()): string {
  for (const h of new Set([home, real(home)])) {
    if (path === h) return "~";
    if (path.startsWith(h + "/")) return `~${path.slice(h.length)}`;
  }
  return path;
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
