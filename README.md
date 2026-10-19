<p align="center">
  <img src="build/icons/128x128.png" width="96" alt="Moire">
</p>

<p align="center"><b>Your agent touched 40 files. Read why, keep the good lines, throw out the rest.</b></p>

<p align="center">
  <a href="https://github.com/backstabslash/moire/actions/workflows/ci.yml"><img src="https://github.com/backstabslash/moire/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/backstabslash/moire/releases/latest"><img src="https://img.shields.io/github/v/release/backstabslash/moire?color=blue" alt="Latest Release"></a>
  <a href="https://www.npmjs.com/package/@backstabslash/moire"><img src="https://img.shields.io/npm/v/@backstabslash/moire?label=npx&color=blue" alt="npm"></a>
  <a href="#install"><img src="https://img.shields.io/badge/platform-Linux%20%7C%20macOS-555" alt="Platforms"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT"></a>
</p>

Moire is a desktop diff viewer for git, built for reviewing what a coding agent changed. The agent explains its work as chapters beside the diff. You step through them, stage what's right and discard what isn't, down to a single line.

![Moire stepping through an agent's notes on a rate limiter rewrite: reading a chapter and its warning, staging the chapter, blinking a hunk, discarding a stray debug line, then writing the commit](demo/demo-light.gif#gh-light-mode-only)
![Moire stepping through an agent's notes on a rate limiter rewrite: reading a chapter and its warning, staging the chapter, blinking a hunk, discarding a stray debug line, then writing the commit](demo/demo-dark.gif#gh-dark-mode-only)

### Read the agent's notes

The agent writes a short summary and a few chapters, each one behaviour of the change with the lines that make it up, across files. Press `.` to walk them in order while the diff follows. Risky lines carry a "Check this" note, and lines no chapter explains are listed, so a stray edit can't hide. Install the skill once and your agent writes the notes after every change:

```sh
npx skills add backstabslash/moire -g
```

It works with Claude Code, Codex, Cursor and other agents that read skills.

### Keep what's right, throw out the rest

- Stage a whole chapter once you've read it, or stage, unstage and discard files, hunks and single lines, with undo
- Commit from the staged view
- Copy selected lines as Markdown with path and line numbers, to paste back into the agent with your feedback
- Blink a hunk between its old and new version in place, so a one-character change jumps out

### And a fast diff viewer

- Side-by-side or unified, with syntax highlighting: unstaged, staged, everything since the last commit, a single commit, or one branch against another
- Updates by itself as files change
- Search across every changed file; lockfiles, generated files and whitespace-only changes are folded away
- Changed images shown old and new; Markdown and SVG can be previewed rendered, with changed blocks marked
- Keyboard-first, with keys you can remap, and six light and dark themes

## Install

```sh
npx @backstabslash/moire
```

installs the latest release, then opens the repo in the current directory. After that Moire updates itself in the background and offers a restart when a new version is ready. On Linux it adds Moire to your app menu and a `moire` command to `~/.local/bin`; on macOS it installs to `~/Applications`. Moire needs `git` 2.26 or newer on your PATH.

Or download from [Releases](https://github.com/backstabslash/moire/releases):

- **Linux** (x64): AppImage, `.deb` or `.rpm`. The AppImage updates itself; the `.deb` and `.rpm` also install a `moire` command, and Moire links to each new release for you to install.
- **macOS**: `.dmg` for Apple silicon or Intel. Builds aren't notarized yet, so the first time macOS blocks the app. Open System Settings → Privacy & Security and click Open Anyway.

## Use

```sh
moire                 # the repo in the current folder, else the last one
moire path/to/repo
```

`moire` returns right away and opens a new window if Moire is already running. The npx install adds the command on macOS too; with the `.dmg` alone, use `open -na moire --args "$PWD"`. Inside the app, `o` lists recent repos and the repo's other worktrees.

<details>
<summary>Keyboard shortcuts</summary>

| Key | Action |
| --- | --- |
| `j` `k` | Next / previous hunk |
| `g g` / `Shift+G` | First / last hunk |
| `[` `]` | Previous / next file |
| `1`–`5` | Unstaged, staged, all, commit, branch vs branch |
| Click or drag line numbers | Select lines (Shift-click extends) |
| `Shift+J` / `Shift+K` | Extend / shrink the selection |
| `s` | Stage the selection or focused hunk (unstage in the staged view) |
| `Shift+S` | Stage every file (unstage all in the staged view) |
| `x` | Discard the selection or focused hunk |
| `u` or `Ctrl+Z` | Undo the last stage, unstage or discard |
| `b` / `Shift+B` | Hold to flip the focused hunk to its old version / keep it blinking |
| `Ctrl+C` / `c` | Copy selected lines as code / as Markdown for an agent (`c` alone copies the focused hunk) |
| `/` or `Ctrl+F` | Search |
| `p` or `Ctrl+P` | Filter the file list |
| `a` | Changed files or all files, gitignored ones included |
| `e` | Open the file in your editor at that line (set `MOIRE_EDITOR`, e.g. `code -g {file}:{line}`, to choose) |
| `o` | Recent repos and the repo's other worktrees |
| `Ctrl+O` | Open a repository |
| `f` | Show full files |
| `v` | Split or unified layout |
| `m` | Preview a Markdown or SVG file, or go back to its diff |
| `t` | Light or dark theme |
| `?` | All keyboard shortcuts |

</details>

To change a key, open Help → Edit keyboard shortcuts…, which creates `keys.json` with every command and its default, for example `{"stage": "S"}`. Changes apply when you save.

## Build from source

```sh
pnpm install
pnpm dev     # run against the last repo, or set MOIRE_REPO=path
pnpm dist    # packages for the current OS into dist/
```
