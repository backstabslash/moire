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
- `design/comparator.html`: visual reference for the UI
- `IDEAS.md`: candidate features and what's out of scope

Flow: renderer → `window.moire` (preload) → `ipcMain` (`src/main/ipc.ts`) → `git`

## Commands
- `MOIRE_REPO=/path/to/repo pnpm dev`: run against a repo (otherwise reopens the last one)
- `pnpm typecheck`: also covers the e2e specs
- `pnpm lint`: ESLint, only rules for unhandled promises, hooks and brace-less effect bodies
- `pnpm format`: Prettier; CI runs `pnpm format:check`
- `pnpm test`: unit tests, including real git in throwaway repos
- `pnpm test:e2e`: builds, then runs Playwright; `npx playwright test` skips the build, so only use it right after one
- `MOIRE_SHOTS=/tmp/shots pnpm test:e2e`: also saves screenshots from the specs that take them
- `pnpm dist --linux AppImage deb --publish never`: local packages in `dist/` (rpm also needs `rpmbuild`)
- Release: bump `version` in package.json, push tag `v<version>`; `.github/workflows/release.yml` uploads Linux and macOS builds to a draft release

Dev-only env vars (ignored when packaged): `MOIRE_PREFS` (preset UI state as JSON), `MOIRE_SCREENSHOT=file.png` (capture once the first file is coloured, then quit), `MOIRE_BENCH=1` (scroll benchmark), `MOIRE_HIDDEN=1` (offscreen window; the e2e specs set it).

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
- Discard backups are unreferenced git objects, so `git gc` prunes them after about two weeks and undo stops working for older discards.
- pnpm blocks install scripts. If `node_modules/electron/dist/electron` is missing, run `node node_modules/electron/install.js`.
- `pkill -f`/`pgrep -f` with a pattern that also appears in your own command kills your shell. Kill by PID instead.
