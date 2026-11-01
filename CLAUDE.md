## Project
moire: a desktop app for reviewing code changes in a local git repo (diffs, staging, search), mostly changes made by AI agents.

## Stack
- Electron 44, electron-vite 6, React 19, TypeScript, pnpm
- Shiki for highlighting (JS regex engine, in a Web Worker)
- vitest for unit tests, Playwright driving the real Electron app for e2e

## Structure
- `src/main/`: main process; all git access shells out to the `git` CLI
- `src/preload/index.ts`: the entire IPC surface, exposed as `window.moire`
- `src/shared/types.ts`: data passed between main and renderer
- `src/renderer/src/model/`: pure functions (rows, selection, search, copy), unit-tested
- `launcher/`: the `npx @backstabslash/moire` package, plain JS with no dependencies; installs the latest GitHub release and opens it

Flow: renderer → `window.moire` (preload) → `ipcMain` (`src/main/ipc.ts`) → `git`

## Commands
- `MOIRE_REPO=/path/to/repo pnpm dev`: run against a repo (otherwise reopens the last one)
- `pnpm typecheck`: also covers the e2e specs
- `pnpm lint`: ESLint, only rules for unhandled promises, hooks and brace-less effect bodies
- `pnpm format`: Prettier; CI runs `pnpm format:check`
- `pnpm test`: unit tests, including real git in throwaway repos
- `pnpm test:e2e`: builds, then runs Playwright; `npx playwright test` skips the build, so only use it right after one
- `MOIRE_SHOTS=/tmp/shots pnpm test:e2e`: also saves screenshots from the specs that take them
- `pnpm demo`: builds, then records `demo/demo-light.gif` and `demo/demo-dark.gif` (in the README, picked by the reader's color scheme) and `demo/demo.mp4` from a scripted run on a throwaway repo. Re-run it after UI changes
- `pnpm dist --linux AppImage deb --publish never`: local packages in `dist/` (rpm also needs `rpmbuild`)
- Release: bump `version` in package.json, then push `git tag -a v<version> --cleanup=verbatim -F notes.md`; `.github/workflows/release.yml` waits for CI to pass on main for that commit, then builds Linux and macOS and publishes the release with the tag message as notes
- Launcher release, only when `launcher/` changes: bump `launcher/package.json`, push tag `launcher-v<version>`; `.github/workflows/launcher.yml` waits for the same CI pass, then publishes to npm

Dev-only env vars (ignored when packaged): `MOIRE_PREFS` (preset UI state as JSON), `MOIRE_SCREENSHOT=file.png` (capture once the first file is coloured, then quit), `MOIRE_BENCH=1` (scroll benchmark), `MOIRE_HIDDEN=1` (offscreen window; the e2e specs set it), `MOIRE_UPDATE` (an `UpdateNotice` as JSON, to show the status bar's update button). The launcher and the packaged app's updater read `MOIRE_RELEASES`, a URL standing in for GitHub's latest-release JSON.

## Verification
Run `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` and `pnpm test:e2e`. For UI changes, also look at a screenshot in light and dark themes.

## Comments
Only where the code would look wrong or arbitrary without one, and a single line. No comments restating what the code does.

## Commits
Subject is `area: imperative summary`, lowercase area from the source layout (`stage`, `diff`, `search`, `ui`, `build`, `release`), 72 chars max. Details go in the body after a blank line.

## Gotchas
- Chromium scroll methods return Promises, so `useEffect(() => el.scrollIntoView())` hands React a non-function cleanup and blanks the UI. Always use braces in effect bodies.
- The renderer is sandboxed with no Node access. Add new capabilities to preload and `ipc.ts`.
- Use `window.moire.copy` for the clipboard, not `navigator.clipboard`, which fails in an unfocused window.
- Stage, unstage and discard write the index or file directly (`src/main/stage.ts`), not through `git apply`. Each action carries the file diff the user saw and is refused if it no longer matches.
- Mermaid runs in its own offscreen page (`src/main/diagrams.ts`, `src/renderer/diagram.html`), never in the main renderer. A file under review can write a diagram that lays out for minutes, and only a separate process can be stopped.
- Discard backups are unreferenced git objects, so `git gc` prunes them after about two weeks and undo stops working for older discards.
- A theme is an entry in `src/renderer/src/model/themes.ts` plus a block and a `data-cvd="on"` block in `styles.css`. `themeRules.ts` holds the colour rules, enforced by `themes.test.ts`: readability, A/B separation for colour blindness, line tints clear of the plate, syntax quieter than the diff. Anything a block leaves out silently inherits Plate. Users add themes in `themes.json` in userData (`src/renderer/src/model/presets.ts`), checked only against the softer `hardToRead` floor.
- pnpm blocks install scripts. If `node_modules/electron/dist/electron` is missing, run `node node_modules/electron/install.js`.
- E2e spec files run in parallel, so they can't share anything outside their temp dirs. The harness gives each app its own clipboard, except `e2e/native-copy.spec.ts`, which needs the real one: any test using Chromium's own copy goes there.
- `pkill -f`/`pgrep -f` with a pattern that also appears in your own command kills your shell. Kill by PID instead.
