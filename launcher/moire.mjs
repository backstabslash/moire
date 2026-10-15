#!/usr/bin/env node
import { resolve } from "node:path";
import { allowNoSandbox, install, installedVersion, latestRelease, launch, newer, runsWithoutSandbox, sandboxBlocked } from "./install.mjs";

if (process.platform !== "linux" && process.platform !== "darwin") {
  console.error("moire runs on Linux and macOS.");
  process.exit(1);
}

const args = process.argv.slice(2);
const repo = resolve(args.find((a) => a !== "--no-sandbox") ?? ".");
if (process.platform === "linux" && sandboxBlocked()) {
  if (args.includes("--no-sandbox")) allowNoSandbox();
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
    } else {
      console.error(`Installed moire ${latest} in ~/Applications.`);
    }
  }
} catch (e) {
  const message = e instanceof Error ? e.message : String(e);
  if (!current) {
    console.error(`Couldn't install moire: ${message}`);
    process.exit(1);
  }
  console.error(`Couldn't update (${message}), opening moire ${current}.`);
}
launch(repo);
