# moire

A desktop app for reviewing code changes in a git repo, made for reading what AI coding agents changed on your machine.

- Side-by-side or unified diffs with syntax highlighting: unstaged, staged, everything since the last commit, a single commit, or one branch against another
- Stage, unstage and discard whole files, hunks or single lines, with undo, and commit from the staged view
- Updates by itself as files change
- Search across every changed file; lockfiles, generated files and whitespace-only changes are folded away
- Copy selected lines as code, or as Markdown with path and line numbers to paste into an agent
- Changed images shown old and new; Markdown and SVG can be previewed rendered, with changed blocks marked

## Install

Download from [Releases](https://github.com/backstabslash/moire/releases). moire needs `git` on your PATH.

- **Linux:** AppImage, `.deb` or `.rpm`. The `.deb` and `.rpm` also install a `moire` command.
- **macOS:** `.dmg` for Apple silicon or Intel. Builds aren't signed yet, so the first time, right-click the app and choose Open.

## Use

```sh
moire                 # reopens the last repo
moire path/to/repo
```

On macOS: `open -na moire --args "$PWD"`. Inside the app, `o` lists recent repos.

| Key | Action |
| --- | --- |
| `j` `k` | Next / previous hunk |
| `[` `]` | Previous / next file |
| `1`–`5` | Unstaged, staged, all, commit, branch vs branch |
| Click or drag line numbers | Select lines (Shift-click extends) |
| `s` | Stage the selection or focused hunk (unstage in the staged view) |
| `x` | Discard the selection or focused hunk |
| `u` | Undo the last stage, unstage or discard |
| `Ctrl+C` / `c` | Copy selected lines as code / as Markdown for an agent |
| `/` or `Ctrl+F` | Search |
| `p` or `Ctrl+P` | Filter the file list |
| `a` | Changed files or all files, gitignored ones included |
| `e` | Open the file in your editor at that line (set `MOIRE_EDITOR`, e.g. `code -g {file}:{line}`, to choose) |
| `o` | Recent repos |
| `f` | Show full files |
| `v` | Split or unified layout |
| `m` | Preview a Markdown or SVG file, or go back to its diff |
| `t` | Light or dark theme |

## Build from source

```sh
pnpm install
pnpm dev     # run against the last repo, or set MOIRE_REPO=path
pnpm dist    # packages for the current OS into dist/
```
