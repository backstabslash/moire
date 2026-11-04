<p align="center">
  <img src="build/icons/128x128.png" width="96" alt="Moire">
</p>

<p align="center"><b>Your agent touched 40 files. Read why, keep what's right, throw out what isn't.</b></p>

<p align="center">
  <a href="https://github.com/backstabslash/moire/actions/workflows/ci.yml"><img src="https://github.com/backstabslash/moire/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/backstabslash/moire/releases/latest"><img src="https://img.shields.io/github/v/release/backstabslash/moire?color=blue" alt="Latest Release"></a>
  <a href="https://www.npmjs.com/package/@backstabslash/moire"><img src="https://img.shields.io/npm/v/@backstabslash/moire?label=npx&color=blue" alt="npm"></a>
  <a href="#install"><img src="https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20Windows-555" alt="Platforms"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT"></a>
</p>

Moire is a desktop diff viewer for reviewing what a coding agent changed. The agent explains its work as chapters beside the diff, and you stage what's right and discard what isn't, down to a single line.

![Moire reviewing an agent's rate limiter rewrite: reading its brief, walking a chapter step by step above the diff, staging that chapter, blinking a one-character fix, discarding a line no chapter explains that exempts login from the limit, previewing the README's changes and diagram while switching themes, then staging the rest](demo/demo-light.gif#gh-light-mode-only)
![Moire reviewing an agent's rate limiter rewrite: reading its brief, walking a chapter step by step above the diff, staging that chapter, blinking a one-character fix, discarding a line no chapter explains that exempts login from the limit, previewing the README's changes and diagram while switching themes, then staging the rest](demo/demo-dark.gif#gh-dark-mode-only)

```sh
npx @backstabslash/moire
```

Run it in any repo. See [Install](#install) for other ways to get it.

## Read the agent's notes

The agent opens with a brief: what you asked for, what changed, what it decided and what you should check. Then come chapters, one behaviour each, across files. Press `.` to walk them: each step's sentence sits above its code, and the diff follows.

- Risky lines carry a "Check this" note
- Lines no chapter explains are listed, so a stray edit can't hide
- Tests and docs fold away as chapters to skim, and whitespace-only chapters are spotted for you
- The agent can add tables, code, a before and after, or screenshots beside the code they prove
- Chapters stay with their commits, so a branch or pull request reads as one story

Install the skill once and your agent writes the notes after every change. It works with Claude Code, Codex, Cursor and other agents that read skills.

```sh
npx skills add backstabslash/moire -g
```

## Keep what's right, throw out the rest

- Stage a whole chapter once you've read it, or stage, unstage and discard files, hunks and single lines, with undo, from the keyboard or a right-click
- Commit from the staged view
- Copy selected lines as Markdown with path and line numbers, to paste back into the agent with your feedback
- Blink a hunk between its old and new version in place, so a one-character change jumps out

## And a fast diff viewer

- Side-by-side or unified, with syntax highlighting: unstaged, staged, everything since the last commit, a single commit, or one branch against another or against your working tree
- Updates by itself as files change
- Changed tests sit right under their code, so you read them together
- Search across every changed file; lockfiles, generated files and whitespace-only changes are folded away, or hide whitespace changes everywhere
- Changed lines show tabs, trailing spaces and invisible characters like a no-break space, which a plain diff hides
- Changed images shown old and new; SVG can be previewed rendered
- Markdown previews as Side by side, Changes or Read, with an outline, coloured code, Mermaid diagrams, GitHub alerts, task lists and footnotes
- Keyboard-first, with keys you can remap and a command palette

## Install

```sh
npx @backstabslash/moire
```

installs the latest release, then opens the repo in the current directory. After that Moire updates itself in the background and offers a restart when a new version is ready. On Linux it adds Moire to your app menu and a `moire` command to `~/.local/bin`; on macOS it installs to `~/Applications`; on Windows it installs to `%LOCALAPPDATA%\moire`, adds Moire to the Start menu and a `moire` command to `%LOCALAPPDATA%\Microsoft\WindowsApps`. Moire needs `git` 2.26 or newer on your PATH.

Or download from [Releases](https://github.com/backstabslash/moire/releases):

- **Linux** (x64): AppImage, `.deb` or `.rpm`. The AppImage updates itself; the `.deb` and `.rpm` also install a `moire` command, and Moire links to each new release for you to install.
- **macOS**: `.dmg` for Apple silicon or Intel. Builds aren't notarized yet, so the first time macOS blocks the app. Open System Settings → Privacy & Security and click Open Anyway.
- **Windows** (x64): `.zip`. Unpack it anywhere and run `moire.exe`; Moire links to each new release for you to download. Builds aren't signed yet, so Windows may warn the first time. Click More info → Run anyway.

## Use

```sh
moire                 # the repo in the current folder, else the last one
moire path/to/repo
moire main..feature   # what feature adds since it left main
moire HEAD~3          # the last three commits plus uncommitted work
moire HEAD~3..        # the last three commits, stopping at HEAD
moire pr 123          # a pull request against its base, fetched with gh
```

A path can come first, as in `moire path/to/repo main..feature`. `moire` returns right away and opens a new window if Moire is already running. The npx install adds the command on macOS too; with the `.dmg` alone, use `open -na moire --args "$PWD"`. On Windows the command comes with the npx install; with the `.zip` alone, run `moire.exe` from its folder with the same arguments. Inside the app, `o` lists recent repos and the repo's other worktrees.

<details>
<summary>Keyboard shortcuts</summary>

| Key | Action |
| --- | --- |
| `j` `k` | Next / previous hunk |
| `g g` / `Shift+G` | First / last hunk |
| `[` `]` | Previous / next file |
| `,` `.` | Previous / next step in the notes |
| `<` `>` | Previous / next place inside a step |
| `i` | Open or close the agent's brief |
| `Shift+I` | Show or hide agent notes |
| `Shift+C` | Stage the open chapter |
| `1`–`5` | Unstaged, staged, all, commit, branch vs branch |
| Click or drag line numbers | Select lines (click again to clear, Shift-click extends) |
| `Shift+J` / `Shift+K` | Extend / shrink the selection |
| `s` | Stage the selection or focused hunk (unstage in the staged view) |
| `Shift+S` | Stage every file (unstage all in the staged view) |
| `x` | Discard the selection or focused hunk |
| `u` or `Ctrl+Z` | Undo the last stage, unstage or discard |
| `b` / `Shift+B` | Hold to flip the focused hunk to its old version / keep it blinking |
| `Ctrl+C` / `c` | Copy selected lines as code / as Markdown for an agent (`c` alone copies the focused hunk) |
| `/` or `Ctrl+F` | Search |
| `p` or `Ctrl+P` | Filter the file list |
| `Ctrl+Shift+P` | Command palette |
| `a` | Changed files or all files, gitignored ones included |
| `e` | Open the file in your editor at that line (asks the first time if it can't find one, or set `MOIRE_EDITOR`, e.g. `code -g {file}:{line}`) |
| `E` | Choose the editor |
| `o` | Recent repos and the repo's other worktrees |
| `Ctrl+O` | Open a repository |
| `f` | Show full files |
| `w` | Ignore whitespace (turns staging off until you show it again) |
| `v` | Split or unified layout |
| `m` | Preview a Markdown or SVG file, or go back to its diff |
| `M` | Next Markdown view: Read, Changes, Side by side (opens on Side by side when the diff has the room) |
| `t` | Light or dark theme |
| `?` | All keyboard shortcuts |

</details>

## Make it yours

Twelve light and dark themes can follow your desktop. To add your own, open the theme menu → Custom themes…, which creates `themes.json`. A theme starts from a built-in one (`light`, `pad`, `gypsum`, `blue-base`, `fathom`, `ditto`, `dark`, `p7`, `safelight`, `cyanotype`, `anodic` or `mezzotint`) and changes only what you name, and tints and surfaces follow from `plate`, `ink`, `a` and `b`. Changes apply when you save, and Moire warns if a theme is hard to read:

```json
{ "themes": [{ "name": "Harbour", "extends": "anodic", "colors": { "plate": "#1c2326", "a": "#e0a050", "b": "#70b8d0" } }] }
```

To change a key, open Help → Edit keyboard shortcuts…, which creates `keys.json` with every command and its default, for example `{"stage": "S"}`. Changes apply when you save.

## Build from source

```sh
pnpm install
pnpm dev     # run against the last repo, or set MOIRE_REPO=path
pnpm dist    # packages for the current OS into dist/
```
