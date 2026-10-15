import { execFileSync, spawn } from "node:child_process";
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
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

/** @typedef {{ name: string, browser_download_url: string, size: number, digest?: string | null }} Asset */
/** @typedef {{ tag_name: string, assets: Asset[] }} Release */

const releases = process.env.MOIRE_RELEASES || "https://api.github.com/repos/backstabslash/moire/releases/latest";

/** @param {string} a @param {string} b */
export function newer(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
}

/** @param {string} platform @param {string} arch @param {string} version */
export function assetName(platform, arch, version) {
  const suffix = arch === "x64" ? "" : `-${arch}`;
  if (platform === "linux") return `moire-${version}${suffix}.tar.gz`;
  if (platform === "darwin") return `moire-${version}${suffix}-mac.zip`;
  return undefined;
}

/** @param {NodeJS.ProcessEnv} env @param {string} home */
export function linuxPaths(env, home) {
  const data = env.XDG_DATA_HOME || join(home, ".local", "share");
  return { root: join(data, "moire"), desktop: join(data, "applications", "moire.desktop"), bin: join(home, ".local", "bin", "moire") };
}

const macApp = () => join(homedir(), "Applications", "moire.app");

/** @param {string} path */
const quote = (path) => `"${path.replace(/["`$\\]/g, "\\$&")}"`;

/** @param {string} root @param {boolean} noSandbox */
export function desktopEntry(root, noSandbox) {
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=moire",
    "Comment=Review code changes in a git repo",
    `Exec=${quote(join(root, "current", "moire"))}${noSandbox ? " --no-sandbox" : ""} %U`,
    `Icon=${join(root, "current", "resources", "icon.png")}`,
    "Terminal=false",
    "Categories=Development;",
    "StartupWMClass=moire",
    "",
  ].join("\n");
}

/** @param {string} root @param {boolean} noSandbox */
export function binScript(root, noSandbox) {
  return `#!/bin/sh\nexec ${quote(join(root, "current", "moire"))}${noSandbox ? " --no-sandbox" : ""} "$@"\n`;
}

export function sandboxBlocked() {
  try {
    return readFileSync("/proc/sys/kernel/apparmor_restrict_unprivileged_userns", "utf8").trim() === "1";
  } catch {
    return false;
  }
}

const optOut = () => join(linuxPaths(process.env, homedir()).root, "no-sandbox");

export function allowNoSandbox() {
  mkdirSync(dirname(optOut()), { recursive: true });
  writeFileSync(optOut(), "");
}

export function runsWithoutSandbox() {
  return sandboxBlocked() && existsSync(optOut());
}

/** @param {string} dir @param {string} prefix */
function clearUnfinished(dir, prefix) {
  for (const name of readdirSync(dir)) if (name.startsWith(prefix)) rmSync(join(dir, name), { recursive: true, force: true });
}

export function installedVersion() {
  try {
    if (process.platform === "darwin") {
      return /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(readFileSync(join(macApp(), "Contents", "Info.plist"), "utf8"))?.[1];
    }
    return readlinkSync(join(linuxPaths(process.env, homedir()).root, "current"));
  } catch {
    return undefined;
  }
}

/** @returns {Promise<Release>} */
export async function latestRelease() {
  const res = await fetch(releases, { headers: { Accept: "application/vnd.github+json" } });
  if (res.status === 404) throw new Error("no release published yet");
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  return /** @type {Promise<Release>} */ (res.json());
}

/** @param {Asset} asset @param {string} file @param {string} label */
async function download(asset, file, label) {
  const want = asset.digest?.replace(/^sha256:/, "");
  if (!want) throw new Error(`${asset.name} has no checksum on GitHub`);
  const res = await fetch(asset.browser_download_url);
  if (!res.ok || !res.body) throw new Error(`downloading ${asset.name}: ${res.status}`);
  const hash = createHash("sha256");
  let done = 0;
  let shown = -1;
  const tty = process.stderr.isTTY;
  const progress = new Transform({
    transform(chunk, _, next) {
      hash.update(chunk);
      done += chunk.length;
      const pct = Math.floor((done / asset.size) * 100);
      if (tty && pct !== shown) process.stderr.write(`\r${label} ${(shown = pct)}%`);
      next(null, chunk);
    },
  });
  if (!tty) process.stderr.write(`${label}\n`);
  await pipeline(Readable.fromWeb(/** @type {import("node:stream/web").ReadableStream} */ (res.body)), progress, createWriteStream(file));
  if (tty) process.stderr.write("\n");
  if (hash.digest("hex") !== want) throw new Error(`${asset.name} doesn't match its checksum on GitHub`);
}

/** @param {Release} release */
export async function install(release) {
  const version = release.tag_name.replace(/^v/, "");
  const name = assetName(process.platform, process.arch, version);
  const asset = release.assets.find((a) => a.name === name);
  if (!asset) throw new Error(`moire ${version} has no build for ${process.platform} ${process.arch}`);
  const label = `Downloading moire ${version} (${Math.round(asset.size / 1e6)} MB)`;
  if (process.platform === "darwin") await installMac(asset, label);
  else await installLinux(asset, version, label);
}

/** @param {Asset} asset @param {string} label */
async function installMac(asset, label) {
  const app = macApp();
  const previous = join(dirname(app), ".moire-previous.app");
  mkdirSync(dirname(app), { recursive: true });
  clearUnfinished(dirname(app), ".moire-tmp-");
  const tmp = mkdtempSync(join(dirname(app), ".moire-tmp-"));
  try {
    const zip = join(tmp, asset.name);
    await download(asset, zip, label);
    execFileSync("ditto", ["-x", "-k", zip, tmp]);
    // The build isn't signed, and Apple silicon refuses to run code without at least an ad-hoc signature.
    execFileSync("codesign", ["--force", "--deep", "--sign", "-", join(tmp, "moire.app")]);
    // The previous bundle stays until the next update, in case a window from it is still open.
    rmSync(previous, { recursive: true, force: true });
    if (existsSync(app)) renameSync(app, previous);
    renameSync(join(tmp, "moire.app"), app);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** @param {Asset} asset @param {string} version @param {string} label */
async function installLinux(asset, version, label) {
  const { root, desktop, bin } = linuxPaths(process.env, homedir());
  const previous = installedVersion();
  mkdirSync(root, { recursive: true });
  clearUnfinished(root, ".tmp-");
  const tmp = mkdtempSync(join(root, ".tmp-"));
  try {
    const tarball = join(tmp, asset.name);
    await download(asset, tarball, label);
    execFileSync("tar", ["-xzf", tarball, "-C", tmp]);
    const dir = readdirSync(tmp).find((n) => n !== asset.name);
    if (!dir) throw new Error(`${asset.name} is empty`);
    rmSync(join(root, version), { recursive: true, force: true });
    renameSync(join(tmp, dir), join(root, version));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  const next = join(root, ".current");
  rmSync(next, { force: true });
  symlinkSync(version, next);
  renameSync(next, join(root, "current"));
  // The previous version stays in case a window from it is still open.
  for (const old of readdirSync(root)) {
    if (!old.startsWith(".") && old !== "current" && old !== version && old !== previous) rmSync(join(root, old), { recursive: true, force: true });
  }

  const noSandbox = runsWithoutSandbox();
  mkdirSync(dirname(desktop), { recursive: true });
  writeFileSync(desktop, desktopEntry(root, noSandbox));
  if (!existsSync(bin) || readFileSync(bin, "utf8").includes(root)) {
    mkdirSync(dirname(bin), { recursive: true });
    writeFileSync(bin, binScript(root, noSandbox), { mode: 0o755 });
  }
}

/** @param {string} repo */
export function launch(repo) {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", ["-na", macApp(), "--args", repo]]
      : [join(linuxPaths(process.env, homedir()).root, "current", "moire"), [...(runsWithoutSandbox() ? ["--no-sandbox"] : []), repo]];
  spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
}
