import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";

const [dist = "dist", out = join(dist, "asar")] = process.argv.slice(2);
const version = JSON.parse(readFileSync("package.json", "utf8")).version;

// As app-builder-lib's asar/integrity.js: SHA256 of the header JSON, read past the two pickle size fields and the string length.
/** @param {Buffer} asar */
function headerSha256(asar) {
  return createHash("sha256")
    .update(asar.subarray(16, 16 + asar.readUInt32LE(12)).toString("utf8"))
    .digest("hex");
}

/** @param {string} dir */
function target(dir) {
  let m = /^linux(?:-(\w+))?-unpacked$/.exec(dir);
  if (m) return { os: "linux", arch: m[1] ?? "x64", asar: join(dist, dir, "resources", "app.asar") };
  m = /^mac(?:-(\w+))?$/.exec(dir);
  if (m && m[1] !== "universal") return { os: "mac", arch: m[1] ?? "x64", asar: join(dist, dir, "moire.app", "Contents", "Resources", "app.asar") };
}

const targets = readdirSync(dist).flatMap((dir) => target(dir) ?? []);
if (!targets.length) throw new Error(`no unpacked builds in ${dist}`);
mkdirSync(out, { recursive: true });
for (const { os, arch, asar } of targets) {
  if (!existsSync(asar)) throw new Error(`missing ${asar}`);
  if (existsSync(`${asar}.unpacked`)) throw new Error(`${asar}.unpacked exists, so app.asar alone isn't the whole app`);
  const data = readFileSync(asar);
  const runtime = readFileSync(join(dirname(asar), "runtime"), "utf8");
  const header = headerSha256(data);
  if (os === "mac") {
    const plist = readFileSync(join(dirname(asar), "..", "Info.plist"), "utf8");
    const built = /<key>Resources\/app\.asar<\/key>\s*<dict>[\s\S]*?<key>hash<\/key>\s*<string>([^<]*)/.exec(plist)?.[1];
    if (built && built !== header) throw new Error(`${asar} header hashes to ${header}, but Info.plist says ${built}`);
  }
  const name = join(out, `moire-${version}-${os}-${arch}.asar`);
  writeFileSync(`${name}.gz`, gzipSync(data, { level: 9 }));
  writeFileSync(`${name}.json`, JSON.stringify({ runtime, sha256: createHash("sha256").update(data).digest("hex"), headerSha256: header }) + "\n");
  console.log(`${name}.gz from ${asar}`);
}
