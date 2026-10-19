import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Asset,
  installedVersion,
  installKind,
  newer,
  npxRoot,
  pickAssets,
  type Release,
  reusesRuntime,
  updateNpx,
  whyManual,
  withAsarHeader,
  withVersion,
} from "./install";
import { dirs } from "./test-repo";

const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

const infoPlist = (version: string, header?: string) =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<plist version="1.0">',
    "  <dict>",
    "    <key>CFBundleShortVersionString</key>",
    `    <string>${version}</string>`,
    "    <key>CFBundleVersion</key>",
    `    <string>${version}</string>`,
    ...(header
      ? [
          "    <key>ElectronAsarIntegrity</key>",
          "    <dict>",
          "      <key>Resources/app.asar</key>",
          "      <dict>",
          "        <key>algorithm</key>",
          "        <string>SHA256</string>",
          "        <key>hash</key>",
          `        <string>${header}</string>`,
          "      </dict>",
          "    </dict>",
        ]
      : []),
    "  </dict>",
    "</plist>",
    "",
  ].join("\n");

const files = new Map<string, Buffer>();
let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const body = files.get(req.url!.slice(1));
    res.writeHead(body ? 200 : 404).end(body);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise((done) => server.close(done)));

const serve = (name: string, body: Buffer, digest: string | null = `sha256:${sha(body)}`): Asset => {
  files.set(name, body);
  return { name, browser_download_url: `${base}/${name}`, size: body.length, digest };
};

describe("newer", () => {
  it("compares each part as a number", () => {
    expect(newer("0.10.0", "0.9.3")).toBe(true);
    expect(newer("0.9.3", "0.10.0")).toBe(false);
    expect(newer("1.0.0", "1.0.0")).toBe(false);
  });
});

describe("install kind", () => {
  it("updates npx installs and AppImages itself, and says why it can't update the rest", () => {
    expect(installKind("linux", true, false, undefined)).toBe("npx");
    expect(installKind("linux", false, true, "deb")).toBe("appimage");
    expect(installKind("linux", false, false, "deb")).toBe("deb");
    expect(installKind("linux", false, false, "rpm")).toBe("rpm");
    expect(installKind("linux", false, false, undefined)).toBe("other");
    expect(installKind("darwin", false, false, undefined)).toBe("dmg");
    expect(installKind("darwin", true, false, undefined)).toBe("npx");
    expect(whyManual("deb")).toContain(".deb");
    expect(whyManual("dmg")).toContain(".dmg");
  });

  it("finds the launcher's install", () => {
    expect(npxRoot("linux", {}, "/home/u")).toBe("/home/u/.local/share/moire");
    expect(npxRoot("linux", { XDG_DATA_HOME: "/data" }, "/home/u")).toBe("/data/moire");
    expect(npxRoot("darwin", { XDG_DATA_HOME: "/data" }, "/Users/u")).toBe("/Users/u/Applications/moire.app");
  });
});

describe("pickAssets", () => {
  const asset = (name: string): Asset => ({ name, browser_download_url: `http://x/${name}`, size: 1, digest: null });
  const release = (names: string[]): Release => ({ tag_name: "v0.2.0", assets: names.map(asset) });

  it("matches the files the release publishes", () => {
    const all = release([
      "moire-0.2.0.tar.gz",
      "moire-0.2.0-arm64.tar.gz",
      "moire-0.2.0-mac.zip",
      "moire-0.2.0-arm64-mac.zip",
      "moire-0.2.0-linux-x64.asar.gz",
      "moire-0.2.0-linux-x64.asar.json",
      "moire-0.2.0-mac-arm64.asar.gz",
      "moire-0.2.0-mac-arm64.asar.json",
    ]);
    const names = (p: ReturnType<typeof pickAssets>) => [p.full?.name, p.asar?.name, p.manifest?.name];
    expect(names(pickAssets(all, "linux", "x64"))).toEqual(["moire-0.2.0.tar.gz", "moire-0.2.0-linux-x64.asar.gz", "moire-0.2.0-linux-x64.asar.json"]);
    expect(names(pickAssets(all, "darwin", "arm64"))).toEqual([
      "moire-0.2.0-arm64-mac.zip",
      "moire-0.2.0-mac-arm64.asar.gz",
      "moire-0.2.0-mac-arm64.asar.json",
    ]);
    expect(names(pickAssets(all, "linux", "arm64"))).toEqual(["moire-0.2.0-arm64.tar.gz", undefined, undefined]);
  });

  it("reuses the runtime only when everything outside app.asar is the same", () => {
    const manifest = { runtime: sha("a"), sha256: sha("x") };
    expect(reusesRuntime(manifest, sha("a"), false)).toBe(true);
    expect(reusesRuntime(manifest, sha("b"), false)).toBe(false);
    expect(reusesRuntime(manifest, undefined, false)).toBe(false);
    expect(reusesRuntime({ runtime: undefined, sha256: sha("x") }, undefined, false)).toBe(false);
    expect(reusesRuntime({ runtime: sha("a"), sha256: "abc" }, sha("a"), false)).toBe(false);
    expect(reusesRuntime(null, sha("a"), false)).toBe(false);
  });

  it("reuses the macOS runtime only when the manifest has the asar header hash for Info.plist", () => {
    expect(reusesRuntime({ runtime: sha("a"), sha256: sha("x") }, sha("a"), true)).toBe(false);
    expect(reusesRuntime({ runtime: sha("a"), sha256: sha("x"), headerSha256: "abc" }, sha("a"), true)).toBe(false);
    expect(reusesRuntime({ runtime: sha("a"), sha256: sha("x"), headerSha256: sha("h") }, sha("a"), true)).toBe(true);
  });

  it("sets the asar header hash in Info.plist only where electron-builder put one", () => {
    expect(withAsarHeader(infoPlist("0.2.0", sha("old")), sha("new"))).toBe(infoPlist("0.2.0", sha("new")));
    expect(withAsarHeader(infoPlist("0.2.0"), sha("new"))).toBe(infoPlist("0.2.0"));
    const two = infoPlist("0.2.0", sha("old")).replace("<key>Resources/app.asar</key>", "<key>Resources/a.asar</key>");
    expect(() => withAsarHeader(two, sha("new"))).toThrow("ElectronAsarIntegrity entry moire can't update");
  });

  it("sets the bundle's version", () => {
    const plist =
      "<key>CFBundleShortVersionString</key>\n\t<string>0.1.0</string>\n<key>CFBundleVersion</key><string>0.1.0</string><key>X</key><string>0.1.0</string>";
    expect(withVersion(plist, "0.2.0")).toBe(
      "<key>CFBundleShortVersionString</key>\n\t<string>0.2.0</string>\n<key>CFBundleVersion</key><string>0.2.0</string><key>X</key><string>0.1.0</string>",
    );
  });
});

describe("updateNpx on Linux", () => {
  function install(runtime: string | null = "rt-1") {
    const dir = mkdtempSync(join(tmpdir(), "moire-install-"));
    dirs.push(dir);
    const root = join(dir, "moire");
    for (const v of ["0.0.9", "0.1.0"]) {
      mkdirSync(join(root, v, "resources"), { recursive: true });
      writeFileSync(join(root, v, "moire"), `binary ${v}`);
      writeFileSync(join(root, v, "resources", "app.asar"), `asar ${v}`);
      if (runtime) writeFileSync(join(root, v, "resources", "runtime"), runtime);
    }
    symlinkSync("0.1.0", join(root, "current"));
    writeFileSync(join(root, "no-sandbox"), "");
    return root;
  }

  function fullBuild(asar: string) {
    const dir = mkdtempSync(join(tmpdir(), "moire-build-"));
    dirs.push(dir);
    mkdirSync(join(dir, "moire-0.2.0", "resources"), { recursive: true });
    writeFileSync(join(dir, "moire-0.2.0", "moire"), "binary 0.2.0");
    writeFileSync(join(dir, "moire-0.2.0", "resources", "app.asar"), asar);
    execFileSync("tar", ["-czf", join(dir, "full.tar.gz"), "-C", dir, "moire-0.2.0"]);
    return readFileSync(join(dir, "full.tar.gz"));
  }

  function release({
    runtime = "rt-1",
    asarSha = sha("asar 0.2.0"),
    fullDigest,
  }: { runtime?: string; asarSha?: string; fullDigest?: string | null } = {}): Release {
    const full = fullBuild("full asar 0.2.0");
    return {
      tag_name: "v0.2.0",
      assets: [
        serve("moire-0.2.0.tar.gz", full, fullDigest === undefined ? `sha256:${sha(full)}` : fullDigest),
        serve("moire-0.2.0-linux-x64.asar.gz", gzipSync("asar 0.2.0")),
        serve("moire-0.2.0-linux-x64.asar.json", Buffer.from(JSON.stringify({ runtime, sha256: asarSha }))),
      ],
    };
  }

  async function update(root: string, r: Release) {
    const failures: string[] = [];
    const moveIn = await updateNpx({
      release: r,
      platform: "linux",
      arch: "x64",
      root,
      runningApp: join(root, "0.1.0"),
      fetch,
      onSmallFailed: (e) => failures.push(e.message),
    });
    expect(moveIn).toBeUndefined();
    return failures;
  }

  const asar = (root: string) => readFileSync(join(root, "current", "resources", "app.asar"), "utf8");

  it("swaps only app.asar into a linked copy when the runtime is unchanged", async () => {
    const root = install();
    expect(await update(root, release())).toEqual([]);
    expect(readlinkSync(join(root, "current"))).toBe("0.2.0");
    expect(installedVersion("linux", root)).toBe("0.2.0");
    expect(asar(root)).toBe("asar 0.2.0");
    expect(statSync(join(root, "0.2.0", "moire")).ino).toBe(statSync(join(root, "0.1.0", "moire")).ino);
    expect(readFileSync(join(root, "0.1.0", "resources", "app.asar"), "utf8")).toBe("asar 0.1.0");
    expect(readdirSync(root).sort()).toEqual(["0.1.0", "0.2.0", "current", "no-sandbox"]);
  });

  it("downloads the full build when the runtime changed, or the install doesn't say which it has", async () => {
    let root = install();
    expect(await update(root, release({ runtime: "rt-2" }))).toEqual([]);
    expect(asar(root)).toBe("full asar 0.2.0");
    root = install(null);
    expect(await update(root, release())).toEqual([]);
    expect(asar(root)).toBe("full asar 0.2.0");
  });

  it("falls back to the full build when app.asar doesn't match its manifest", async () => {
    const root = install();
    expect(await update(root, release({ asarSha: sha("something else") }))).toEqual(["moire-0.2.0-linux-x64.asar.gz doesn't match its manifest"]);
    expect(asar(root)).toBe("full asar 0.2.0");
  });

  it("leaves the working install alone when every download fails", async () => {
    const root = install();
    const r = release({ asarSha: sha("something else"), fullDigest: `sha256:${sha("nope")}` });
    await expect(update(root, r)).rejects.toThrow("moire-0.2.0.tar.gz doesn't match its checksum on GitHub");
    expect(readlinkSync(join(root, "current"))).toBe("0.1.0");
    expect(asar(root)).toBe("asar 0.1.0");
    expect(readdirSync(root).sort()).toEqual(["0.0.9", "0.1.0", "current", "no-sandbox"]);
    await expect(update(root, release({ runtime: "rt-2", fullDigest: null }))).rejects.toThrow("has no checksum on GitHub");
    expect(existsSync(join(root, "0.2.0"))).toBe(false);
  });
});

describe("updateNpx on macOS", () => {
  const path = process.env.PATH;

  beforeAll(() => {
    const bin = mkdtempSync(join(tmpdir(), "moire-bin-"));
    dirs.push(bin);
    writeFileSync(join(bin, "ditto"), '#!/bin/sh\nif [ "$1" = -x ]; then exec unzip -q "$3" -d "$4"; fi\nexec cp -R "$1" "$2"\n');
    writeFileSync(join(bin, "codesign"), "#!/bin/sh\n");
    chmodSync(join(bin, "ditto"), 0o755);
    chmodSync(join(bin, "codesign"), 0o755);
    process.env.PATH = `${bin}:${path}`;
  });
  afterAll(() => {
    process.env.PATH = path;
  });

  function bundle(app: string, version: string, header?: string) {
    mkdirSync(join(app, "Contents", "Resources"), { recursive: true });
    writeFileSync(join(app, "Contents", "Info.plist"), infoPlist(version, header));
    writeFileSync(join(app, "Contents", "Resources", "app.asar"), `asar ${version}`);
    writeFileSync(join(app, "Contents", "Resources", "runtime"), "rt-1");
  }

  function install(header?: string) {
    const dir = mkdtempSync(join(tmpdir(), "moire-install-"));
    dirs.push(dir);
    const root = join(dir, "Applications", "moire.app");
    bundle(root, "0.1.0", header);
    return root;
  }

  function release(manifest: object): Release {
    const dir = mkdtempSync(join(tmpdir(), "moire-build-"));
    dirs.push(dir);
    bundle(join(dir, "moire.app"), "0.2.0", sha("full header"));
    writeFileSync(join(dir, "moire.app", "Contents", "Resources", "app.asar"), "full asar 0.2.0");
    execFileSync("zip", ["-qr", "full.zip", "moire.app"], { cwd: dir });
    return {
      tag_name: "v0.2.0",
      assets: [
        serve("moire-0.2.0-arm64-mac.zip", readFileSync(join(dir, "full.zip"))),
        serve("moire-0.2.0-mac-arm64.asar.gz", gzipSync("asar 0.2.0")),
        serve("moire-0.2.0-mac-arm64.asar.json", Buffer.from(JSON.stringify({ runtime: "rt-1", sha256: sha("asar 0.2.0"), ...manifest }))),
      ],
    };
  }

  async function update(root: string, r: Release) {
    const failures: string[] = [];
    const moveIn = await updateNpx({
      release: r,
      platform: "darwin",
      arch: "arm64",
      root,
      runningApp: root,
      fetch,
      onSmallFailed: (e) => failures.push(e.message),
    });
    moveIn!();
    return failures;
  }

  const read = (root: string, ...path: string[]) => readFileSync(join(root, "Contents", ...path), "utf8");

  it("gives the copied bundle's Info.plist the new version and asar header hash", async () => {
    const root = install(sha("old header"));
    expect(await update(root, release({ headerSha256: sha("new header") }))).toEqual([]);
    expect(read(root, "Resources", "app.asar")).toBe("asar 0.2.0");
    expect(read(root, "Info.plist")).toBe(infoPlist("0.2.0", sha("new header")));
    expect(installedVersion("darwin", root)).toBe("0.2.0");
  });

  it("leaves Info.plist without an asar header hash when the install had none", async () => {
    const root = install();
    expect(await update(root, release({ headerSha256: sha("new header") }))).toEqual([]);
    expect(read(root, "Resources", "app.asar")).toBe("asar 0.2.0");
    expect(read(root, "Info.plist")).toBe(infoPlist("0.2.0"));
  });

  it("downloads the full build when the manifest has no asar header hash", async () => {
    const root = install(sha("old header"));
    expect(await update(root, release({}))).toEqual([]);
    expect(read(root, "Resources", "app.asar")).toBe("full asar 0.2.0");
    expect(read(root, "Info.plist")).toBe(infoPlist("0.2.0", sha("full header")));
  });
});
