import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, win32 } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";
import { promisify } from "node:util";
import { createGunzip } from "node:zlib";

const run = promisify(execFile);
// Electron's fs.promises.rm takes an .asar for a folder and stops with ENOTEMPTY, leaving the app's own old versions behind.
const removeTree = async (path: string) => {
  if (process.platform !== "win32") return void (await run("rm", ["-rf", "--", path]));
  if (!existsSync(path)) return;
  await run("cmd.exe", ["/d", "/s", "/c", `rmdir /s /q "${path}"`], { windowsVerbatimArguments: true, windowsHide: true });
};

export interface Asset {
  name: string;
  browser_download_url: string;
  size: number;
  digest?: string | null;
}

export interface Release {
  tag_name: string;
  assets: Asset[];
}

export interface Manifest {
  runtime: string;
  sha256: string;
  // SHA256 of app.asar's header, which Info.plist's ElectronAsarIntegrity carries; releases before it have none.
  headerSha256?: string;
}

type Get = (url: string) => Promise<Response>;

export type InstallKind = "npx" | "appimage" | "deb" | "rpm" | "dmg" | "other";

export function newer(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
}

const quote = (path: string) => `"${path.replace(/["`$\\]/g, "\\$&")}"`;

// Self-updates skip the launcher, so the app rewrites this copy of its script.
export function macShim(app: string): string {
  return [
    "#!/bin/sh",
    'case "$1 $2" in',
    '  "pr "[0-9]*) dir="$PWD" ;;',
    '  /*) dir="$1"; shift ;;',
    '  *) if [ -e "$1" ]; then dir="$PWD/$1"; shift; else dir="$PWD"; fi ;;',
    "esac",
    `exec open -na ${quote(app)} --args "$dir" "$@"`,
    "",
  ].join("\n");
}

export function refreshMacShim(app: string, home: string): void {
  const bin = join(home, ".local", "bin", "moire");
  const current = existsSync(bin) ? readFileSync(bin, "utf8") : "";
  if (current.includes(app) && current !== macShim(app)) writeFileSync(bin, macShim(app), { mode: 0o755 });
}

export function installKind(platform: string, npx: boolean, appImage: boolean, packageType: string | undefined): InstallKind {
  if (npx) return "npx";
  if (appImage) return "appimage";
  if (platform === "darwin") return "dmg";
  return packageType === "deb" || packageType === "rpm" ? packageType : "other";
}

export function whyManual(kind: InstallKind): string {
  if (kind === "deb" || kind === "rpm") return `Installed from the .${kind}, so only your package manager can replace it.`;
  if (kind === "dmg") return "Installed from the .dmg, which moire can't replace by itself; installs made with npx update automatically.";
  return "moire replaces itself only when installed with npx or run as an AppImage.";
}

export function npxRoot(platform: string, env: NodeJS.ProcessEnv, home: string): string {
  if (platform === "win32") return win32.join(env.LOCALAPPDATA || win32.join(home, "AppData", "Local"), "moire");
  const data = env.XDG_DATA_HOME || join(home, ".local", "share");
  return platform === "darwin" ? join(home, "Applications", "moire.app") : join(data, "moire");
}

export function installedVersion(platform: string, root: string): string | undefined {
  try {
    if (platform === "darwin") {
      return /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(readFileSync(join(root, "Contents", "Info.plist"), "utf8"))?.[1];
    }
    return basename(readlinkSync(join(root, "current")));
  } catch {
    return undefined;
  }
}

export function pickAssets(release: Release, platform: string, arch: string): { full?: Asset; asar?: Asset; manifest?: Asset } {
  const version = release.tag_name.replace(/^v/, "");
  const suffix = arch === "x64" ? "" : `-${arch}`;
  const find = (name: string) => release.assets.find((a) => a.name === name);
  if (platform === "win32") return { full: find(`moire-${version}${suffix}-win.zip`) };
  const full = platform === "darwin" ? `moire-${version}${suffix}-mac.zip` : `moire-${version}${suffix}.tar.gz`;
  const small = `moire-${version}-${platform === "darwin" ? "mac" : "linux"}-${arch}.asar`;
  return { full: find(full), asar: find(`${small}.gz`), manifest: find(`${small}.json`) };
}

const isSha = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f]{64}$/.test(s);

export function reusesRuntime(manifest: unknown, runtime: string | undefined, mac: boolean): manifest is Manifest {
  const m = manifest as Partial<Manifest> | null;
  return !!runtime && m?.runtime === runtime && isSha(m.sha256) && (!mac || isSha(m.headerSha256));
}

const resourcesOf = (app: string, mac: boolean) => (mac ? join(app, "Contents", "Resources") : join(app, "resources"));

function runtimeOf(app: string, mac: boolean): string | undefined {
  try {
    return readFileSync(join(resourcesOf(app, mac), "runtime"), "utf8").trim();
  } catch {
    return undefined;
  }
}

export function withVersion(plist: string, version: string): string {
  return plist.replace(/(<key>(?:CFBundleShortVersionString|CFBundleVersion)<\/key>\s*<string>)[^<]*/g, `$1${version}`);
}

const integrity =
  /(<key>ElectronAsarIntegrity<\/key>\s*<dict>\s*<key>Resources\/app\.asar<\/key>\s*<dict>\s*<key>algorithm<\/key>\s*<string>SHA256<\/string>\s*<key>hash<\/key>\s*<string>)[0-9a-f]*(?=<\/string>\s*<\/dict>\s*<\/dict>)/;

export function withAsarHeader(plist: string, sha256: string): string {
  if (!plist.includes("<key>ElectronAsarIntegrity</key>")) return plist;
  if (!integrity.test(plist)) throw new Error("Info.plist has an ElectronAsarIntegrity entry moire can't update");
  return plist.replace(integrity, `$1${sha256}`);
}

function hasher() {
  const hash = createHash("sha256");
  const stream = new Transform({
    transform(chunk: Buffer, _, next) {
      hash.update(chunk);
      next(null, chunk);
    },
  });
  return { stream, hex: () => hash.digest("hex") };
}

async function download(get: Get, asset: Asset, file: string, gunzippedSha256?: string) {
  const want = asset.digest?.replace(/^sha256:/, "");
  if (!want) throw new Error(`${asset.name} has no checksum on GitHub`);
  const res = await get(asset.browser_download_url);
  if (!res.ok || !res.body) throw new Error(`downloading ${asset.name}: ${res.status}`);
  const packed = hasher();
  const plain = hasher();
  const stages = gunzippedSha256 ? [packed.stream, createGunzip(), plain.stream] : [packed.stream];
  await pipeline([Readable.fromWeb(res.body as ReadableStream), ...stages, createWriteStream(file)]);
  if (packed.hex() !== want) throw new Error(`${asset.name} doesn't match its checksum on GitHub`);
  if (gunzippedSha256 && plain.hex() !== gunzippedSha256) throw new Error(`${asset.name} doesn't match its manifest`);
}

async function unpackFull(get: Get, asset: Asset, dir: string, mac: boolean): Promise<string> {
  mkdirSync(dir);
  const file = join(dir, asset.name);
  await download(get, asset, file);
  if (asset.name.endsWith("-win.zip")) {
    const app = join(dir, "moire");
    mkdirSync(app);
    // Windows' own tar reads zips; one from Git for Windows earlier on PATH can't.
    await run(join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe"), ["-xf", file, "-C", app], { windowsHide: true });
    return app;
  }
  if (mac) {
    await run("ditto", ["-x", "-k", file, dir]);
    return join(dir, "moire.app");
  }
  await run("tar", ["-xzf", file, "-C", dir]);
  const top = readdirSync(dir).find((n) => n !== asset.name);
  if (!top) throw new Error(`${asset.name} is empty`);
  return join(dir, top);
}

async function patchCopy(get: Get, from: string, asar: Asset, manifest: Asset, version: string, dir: string, mac: boolean) {
  mkdirSync(dir);
  await download(get, manifest, join(dir, manifest.name));
  const wanted: unknown = JSON.parse(readFileSync(join(dir, manifest.name), "utf8"));
  if (!reusesRuntime(wanted, runtimeOf(from, mac), mac)) return undefined;
  const to = join(dir, mac ? "moire.app" : "moire");
  if (mac) await run("ditto", [from, to]);
  else await run("cp", ["-al", from, to]);
  const resources = resourcesOf(to, mac);
  const part = join(resources, ".app.asar.part");
  await download(get, asar, part, wanted.sha256);
  renameSync(part, join(resources, "app.asar"));
  if (mac) {
    const plist = join(to, "Contents", "Info.plist");
    writeFileSync(plist, withAsarHeader(withVersion(readFileSync(plist, "utf8"), version), wanted.headerSha256!));
  }
  return to;
}

async function placeVersion(root: string, version: string, built: string, running: string, windows: boolean) {
  await removeTree(join(root, version));
  renameSync(built, join(root, version));
  const next = join(root, ".current");
  rmSync(next, { force: true });
  // Symlinks need Developer Mode on Windows, a junction doesn't, but it can't replace current by renaming over it.
  if (windows) {
    symlinkSync(join(root, version), next, "junction");
    rmSync(join(root, "current"), { force: true });
  } else symlinkSync(version, next);
  renameSync(next, join(root, "current"));
  for (const old of readdirSync(root, { withFileTypes: true })) {
    if (!old.isDirectory() || old.name.startsWith(".") || old.name === version || old.name === running) continue;
    if (windows) await removeUnlessRunning(join(root, old.name));
    else await removeTree(join(root, old.name));
  }
}

// Windows deletes all but the files in use, so a copy that's still open is moved first, which Windows refuses.
async function removeUnlessRunning(dir: string) {
  const doomed = join(dirname(dir), `.old-${basename(dir)}`);
  try {
    renameSync(dir, doomed);
  } catch {
    return;
  }
  await removeTree(doomed);
}

function swapMac(app: string, built: string) {
  const previous = join(dirname(app), ".moire-previous.app");
  rmSync(previous, { recursive: true, force: true });
  if (existsSync(app)) renameSync(app, previous);
  try {
    renameSync(built, app);
  } catch (e) {
    renameSync(previous, app);
    throw e;
  }
}

export interface NpxUpdate {
  release: Release;
  platform: string;
  arch: string;
  root: string;
  runningApp: string;
  // Electron's net.fetch in the app: Node's own fetch trips an assertion when a server closes the socket during backpressure.
  fetch: Get;
  onSmallFailed(e: Error): void;
}

export type MoveIn = () => void;

export async function updateNpx({ release, platform, arch, root, runningApp, fetch: get, onSmallFailed }: NpxUpdate): Promise<MoveIn | undefined> {
  const version = release.tag_name.replace(/^v/, "");
  const { full, asar, manifest } = pickAssets(release, platform, arch);
  if (!full) throw new Error(`moire ${version} has no build for ${platform} ${arch}`);
  const mac = platform === "darwin";
  const parent = mac ? dirname(root) : root;
  const prefix = mac ? ".moire-tmp-" : ".tmp-";
  mkdirSync(parent, { recursive: true });
  for (const name of readdirSync(parent)) if (name.startsWith(prefix)) await removeTree(join(parent, name));
  const tmp = mkdtempSync(join(parent, prefix));
  try {
    let built: string | undefined;
    if (asar && manifest) {
      built = await patchCopy(get, runningApp, asar, manifest, version, join(tmp, "small"), mac).catch((e: Error) => {
        onSmallFailed(e);
        return undefined;
      });
    }
    built ??= await unpackFull(get, full, join(tmp, "full"), mac);
    if (!mac) {
      await placeVersion(root, version, built, basename(runningApp), platform === "win32");
      await removeTree(tmp);
      return undefined;
    }
    // The build isn't signed, and Apple silicon refuses to run code without at least an ad-hoc signature.
    await run("codesign", ["--force", "--deep", "--sign", "-", built]);
    const ready = built;
    return () => {
      try {
        swapMac(root, ready);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    };
  } catch (e) {
    await removeTree(tmp);
    throw e;
  }
}
