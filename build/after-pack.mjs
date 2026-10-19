import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync, renameSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

/** @param {import("app-builder-lib").AfterPackContext} context */
export default async function afterPack({ appOutDir, electronPlatformName, packager }) {
  const mac = electronPlatformName === "darwin";
  const app = mac ? join(appOutDir, `${packager.appInfo.productFilename}.app`) : appOutDir;
  const resources = mac ? join(app, "Contents", "Resources") : join(app, "resources");
  if (mac) renameHelpers(app, packager.appInfo.productFilename, packager.platformSpecificBuildOptions.extendInfo?.CFBundleName);
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

/** @param {string} plist */
function stableInfo(plist) {
  return plist
    .replace(/(<key>(?:CFBundleShortVersionString|CFBundleVersion)<\/key>\s*<string>)[^<]*/g, "$1")
    .replace(/<key>ElectronAsarIntegrity<\/key>\s*<dict>[\s\S]*?<\/dict>\s*<\/dict>/, "");
}

/**
 * Electron finds its helpers by CFBundleName, so they must match it exactly on case-sensitive volumes.
 * @param {string} app
 * @param {string} from
 * @param {string | undefined} to
 */
function renameHelpers(app, from, to) {
  if (!to || to === from) return;
  const frameworks = join(app, "Contents", "Frameworks");
  for (const name of readdirSync(frameworks)) {
    if (!name.startsWith(`${from} Helper`) || !name.endsWith(".app")) continue;
    const helper = join(frameworks, name);
    const exe = name.slice(0, -".app".length);
    const renamed = to + exe.slice(from.length);
    renameSync(join(helper, "Contents", "MacOS", exe), join(helper, "Contents", "MacOS", renamed));
    const plist = join(helper, "Contents", "Info.plist");
    writeFileSync(plist, readFileSync(plist, "utf8").replaceAll(`<string>${exe}</string>`, `<string>${renamed}</string>`));
    renameSync(helper, join(frameworks, `${renamed}.app`));
  }
}
