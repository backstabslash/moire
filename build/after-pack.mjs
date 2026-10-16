import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

// Fingerprints everything outside app.asar, so an update swaps in only app.asar when this matches the installed copy's.
/** @param {import("app-builder-lib").AfterPackContext} context */
export default async function afterPack({ appOutDir, electronPlatformName, packager }) {
  const mac = electronPlatformName === "darwin";
  const app = mac ? join(appOutDir, `${packager.appInfo.productFilename}.app`) : appOutDir;
  const resources = mac ? join(app, "Contents", "Resources") : join(app, "resources");
  const skip = new Set([join(resources, "app.asar"), join(resources, "runtime")]);
  const hash = createHash("sha256").update(JSON.stringify(packager.config.electronFuses ?? null));
  /** @param {string} dir */
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) {
        walk(path);
        continue;
      }
      if (skip.has(path)) continue;
      let data = stat.isSymbolicLink() ? Buffer.from(`-> ${readlinkSync(path)}`) : readFileSync(path);
      if (name === "Info.plist") data = Buffer.from(stableInfo(data.toString("utf8")));
      hash.update(`${relative(app, path)}\0${createHash("sha256").update(data).digest("hex")}\n`);
    }
  };
  walk(app);
  writeFileSync(join(resources, "runtime"), hash.digest("hex"));
}

// The version and the asar header hash change every release, and an update rewrites both itself.
/** @param {string} plist */
function stableInfo(plist) {
  return plist
    .replace(/(<key>(?:CFBundleShortVersionString|CFBundleVersion)<\/key>\s*<string>)[^<]*/g, "$1")
    .replace(/<key>ElectronAsarIntegrity<\/key>\s*<dict>[\s\S]*?<\/dict>\s*<\/dict>/, "");
}
