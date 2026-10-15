# @backstabslash/moire

Installs and opens [moire](https://github.com/backstabslash/moire), a desktop app for reviewing code changes in a git repo.

```sh
npx @backstabslash/moire [path]
```

The first run downloads the latest release from GitHub and installs it: to `~/Applications/moire.app` on macOS, or to `~/.local/share/moire` on Linux with an app menu entry and a `moire` command in `~/.local/bin`. Later runs update it when a new release is out, then open the repo at `path` (default: the current directory). moire needs `git` on your PATH.

Ubuntu 23.10 and later block Chromium's sandbox for apps installed in your home folder. There, the launcher stops and points you to the `.deb`, which keeps the sandbox. Pass `--no-sandbox` to install and run moire without it; later runs remember that.

`--uninstall` removes what the launcher installed and leaves your settings in place. If GitHub's rate limit gets in the way, set `GITHUB_TOKEN`.
