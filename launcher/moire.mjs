#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, sep } from "node:path";
import {
  allowNoSandbox,
  install,
  installedVersion,
  latestRelease,
  launch,
  newer,
  parseArgs,
  runsWithoutSandbox,
  sandboxBlocked,
  uninstall,
  usage,
  windowsPaths,
} from "./install.mjs";

const opts = parseArgs(process.argv.slice(2));
const tilde = (/** @type {string} */ path) => (path.startsWith(homedir() + sep) ? `~${path.slice(homedir().length)}` : path);

if (opts.unknown) {
  console.error(`Unknown option ${opts.unknown}\n${usage}`);
  process.exit(2);
}
if (opts.help) {
  console.log(
    [
      usage,
      "",
      "Installs moire, or updates it when a new release is out, then opens the git repo at path (default: the current folder).",
      "A comparison opens straight onto it: main..feature, HEAD~3 (up to the last commit) or pr 123 (needs gh).",
      "",
      "  --no-sandbox  run without Chromium's sandbox, on Linux systems that block it",
      "  --uninstall   remove moire from your home folder; your settings stay",
      "  --version     print the launcher's version and the installed moire's",
    ].join("\n"),
  );
  process.exit(0);
}
if (process.platform !== "linux" && process.platform !== "darwin" && process.platform !== "win32") {
  console.error("moire runs on Linux, macOS and Windows.");
  process.exit(1);
}
if (opts.version) {
  const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
  const current = installedVersion();
  console.log(`launcher ${version}\n${current ? `moire ${current}` : "moire isn't installed yet"}`);
  process.exit(0);
}
if (opts.uninstall) {
  let result;
  try {
    result = uninstall();
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
  const { removed, data } = result;
  if (!removed.length) console.log("moire isn't installed in your home folder, so there's nothing to remove.");
  else console.log(`Removed ${removed.map(tilde).join(", ")}.\nYour settings stay in ${tilde(data)}; delete that folder to remove them too.`);
  process.exit(0);
}

const repo = resolve(opts.path ?? ".");
if (process.platform === "linux" && sandboxBlocked()) {
  if (opts.noSandbox) allowNoSandbox();
  else if (!runsWithoutSandbox()) {
    console.error(
      [
        "This system blocks Chromium's sandbox for apps installed in your home folder.",
        "Install the .deb from https://github.com/backstabslash/moire/releases/latest, which keeps the sandbox,",
        "or run `npx @backstabslash/moire --no-sandbox` to use moire without it.",
      ].join("\n"),
    );
    process.exit(1);
  }
}
const current = installedVersion();
try {
  const release = await latestRelease();
  const latest = release.tag_name.replace(/^v/, "");
  if (!current || newer(latest, current)) {
    await install(release);
    if (process.platform === "linux") {
      console.error(`Installed moire ${latest}. It's in your app menu, and ~/.local/bin/moire opens it from a terminal.`);
    } else if (process.platform === "win32") {
      const { bin } = windowsPaths(process.env, homedir());
      const onPath = (process.env.PATH ?? "").toLowerCase().split(";").includes(bin.toLowerCase());
      console.error(
        `Installed moire ${latest}. It's in your Start menu${onPath ? ", and `moire` opens it from a terminal." : `; add ${bin} to your PATH to open it with \`moire\`.`}`,
      );
    } else {
      console.error(`Installed moire ${latest} in ~/Applications, and ~/.local/bin/moire opens it from a terminal.`);
    }
  }
} catch (e) {
  const message = e instanceof Error ? e.message : String(e);
  if (!current) {
    console.error(
      /** @type {{ offline?: boolean }} */ (e).offline ? "Can't reach GitHub, and moire isn't installed yet." : `Couldn't install moire: ${message}`,
    );
    process.exit(1);
  }
  console.error(`Couldn't update (${message}), opening moire ${current}.`);
}
const failure = await launch(repo, opts.compare);
if (failure) {
  console.error(`moire didn't start:\n${failure}`);
  process.exit(1);
}
