import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { buildKeymap, command, type CommandId, lookup } from "../../shared/keymap";
import type { CompareMode, FileContents, FileDiff, Hunk, LineRef, NoteRange, NotesFile, Placement, RepoInfo, StageAction, Upstream } from "../../shared/types";
import { CommitBox } from "./components/CommitBox";
import { CommitHead } from "./components/CommitHead";
import { CommandPalette } from "./components/CommandPalette";
import { type Blink, DiffView, type DiffViewHandle, type Preview, type Spot } from "./components/DiffView";
import { NoChanges, NoRepo } from "./components/EmptyState";
import { EncodingNotice } from "./components/EncodingNotice";
import { InvisibleNotice } from "./components/InvisibleNotice";
import { FileMenu, type MenuAction, type MenuAt } from "./components/FileMenu";
import { HoverTip } from "./components/HoverTip";
import { ClashBar, ClashView, DropFoot, DropSlots, DropStyle, ghostTree } from "./components/FilesIn";
import { Key, keyText, MAC, setKeymap, useKeymap } from "./components/Key";
import { KeysHelp } from "./components/KeysHelp";
import { Brief } from "./components/Brief";
import { NOTES_WIDTH, NotesPanel } from "./components/NotesPanel";
import { StepCaption } from "./components/StepCaption";
import { EditorPicker } from "./components/EditorPicker";
import { RepoPicker } from "./components/RepoPicker";
import { SearchBar } from "./components/SearchBar";
import { StagedNotice, StageProgress } from "./components/StageProgress";
import { type FilesView, type Reveal, SIDE_WIDTH, Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { CODE_SIZE } from "./components/ThemePicker";
import { Toast, type ToastMsg } from "./components/Toast";
import { type LastPicked, type PickerState, Toolbar } from "./components/Toolbar";
import { highlight, warm } from "./highlight/client";
import type { TokLines } from "./highlight/types";
import { fileKey as fileKeyOf, fuzzyMatch, hashString, orderFiles, remember } from "./model/files";
import { hiddenLines } from "./model/invisible";
import { langFor } from "./model/lang";
import { hasTwoVersions, PREVIEW_CHOICES, PREVIEW_VIEWS, previewOf, type PreviewChoice, readOnly, resolveView } from "./model/preview";
import { buildRows, followHunk, hunkChanges, type Layout, type LineRow, notUtf8, type Row, type Scope, splitLines, type Stub, withStubs } from "./model/rows";
import {
  bordersDeletion,
  type ChapterTarget,
  type Placed,
  chapterRefs,
  chapterSize,
  firstUncovered,
  placeRange,
  rangeStaged,
  uncovered,
} from "../../shared/chapters";
import {
  captionOf,
  firstStopLeft,
  holdsMultilineText,
  hunkAt,
  leadOf,
  lineKeys,
  type Mark,
  nextStep,
  nextStop,
  rowOfLine,
  rowToShow,
  sameStop,
  shapeOf,
  type Skim,
  skimOf,
  type Stop,
  stopsOf,
  whitespaceOnly,
} from "./model/notes";
import { copyCode, copyMarkdown, copySide } from "./model/copy";
import { strokeOf, sameKey } from "./model/keyboard";
import { type Col, carryKeys, changedRefs, hunkChange, hunkOfKey, hunkRefs, isPicked, lineKey } from "./model/selection";
import { type Hit, hitKeys, hitRow } from "./model/search";
import { idsOf, isThemeId, type ThemeId, toneOf } from "./model/themes";
import { useDiff } from "./useDiff";
import { isIgnored, useFilesIn } from "./useFilesIn";
import { useSearch } from "./useSearch";
import { type SelectHow, useSelection } from "./useSelection";
import { usePresets } from "./usePresets";
import { firstTime, savedStop, saveStop, useStored, useStoredNumber, useStoredText } from "./useStored";
import { useTree } from "./useTree";

type SimpleMode = "unstaged" | "staged" | "all";

const BLINK_MS = 650;
const SEQUENCE_MS = 1000;
const PREV_FILE_HOLD_MS = 100;
const SPLIT_MIN_DIFF_WIDTH_PX = 1000;
const MIN_DIFF_WIDTH_PX = 360;
const WALK_MIN_DIFF_WIDTH_PX = 560;
const REMEMBERED_REPOS = 50;
const FOLDER_MODE: CompareMode = { kind: "all" };
const GIT_ONLY: CommandId[] = [
  "unstaged",
  "staged",
  "all",
  "commit",
  "branches",
  "compare",
  "stage",
  "discard",
  "stageAll",
  "discardFile",
  "undo",
  "allFiles",
  "ignoreWhitespace",
  "notes",
  "brief",
  "stageChapter",
  "nextNote",
  "prevNote",
  "pasteFiles",
];
// With the brief up no diff is showing, so any other command would act on lines you can't see.
const BRIEF_KEEPS: readonly CommandId[] = [
  "brief",
  "undo",
  "nextNote",
  "prevNote",
  "nextPlace",
  "prevPlace",
  "filterFiles",
  "help",
  "palette",
  "theme",
  "unstaged",
  "staged",
  "all",
  "commit",
  "branches",
  "compare",
  "refresh",
  "openRepo",
  "recentRepos",
  "editKeys",
  "editThemes",
  "zoomIn",
  "zoomOut",
  "zoomReset",
];
type Version = "head" | "index" | "worktree";
type OldAndNewSide = readonly [oldSide: Version, newSide: Version];
const COMPARE_KEYS: ReadonlySet<CommandId> = new Set<CommandId>(["unstaged", "staged", "all", "commit", "branches"]);
const SIDES: Record<string, OldAndNewSide> = { unstaged: ["index", "worktree"], staged: ["head", "index"], all: ["head", "worktree"] };

const outdated = (stubs: Stub[]) => (stubs.some((s) => s.undoable) ? stubs.map((s) => (s.undoable ? { ...s, undoable: false } : s)) : stubs);
const placeAgainstShownOrWorktree = (r: NoteRange, shownLines: string[] | null, placedWithNotes: Placement | undefined): Placement =>
  shownLines ? placeRange(r, shownLines) : (placedWithNotes ?? placeRange(r, null));

interface Shown {
  root: string;
  file: FileDiff;
  key: string;
  contents: FileContents | null;
  tokens: [TokLines | null, TokLines | null] | null;
}

const darkDesktop = matchMedia("(prefers-color-scheme: dark)");

function useSystemTone() {
  return useSyncExternalStore(
    (changed) => {
      darkDesktop.addEventListener("change", changed);
      return () => darkDesktop.removeEventListener("change", changed);
    },
    () => (darkDesktop.matches ? "dark" : "light"),
  );
}

function openFiles(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem("moire.open-files") ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

function rememberFile(root: string, path: string) {
  const { [root]: _, ...rest } = openFiles();
  const kept = Object.entries(rest).slice(1 - REMEMBERED_REPOS);
  localStorage.setItem("moire.open-files", JSON.stringify(Object.fromEntries([...kept, [root, path]])));
}

function message(err: unknown) {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

export function App() {
  const [repo, setRepo] = useState<RepoInfo | null>(null);
  const [booting, setBooting] = useState(true);
  const [simpleMode, setSimpleMode] = useStored<SimpleMode>("mode", "unstaged", ["unstaged", "staged", "all"]);
  const [special, setSpecial] = useState<CompareMode | null>(null);
  const [lastPicked, setLastPicked] = useState<LastPicked>({});
  const folder = !!repo?.folder;
  const wantMode = useMemo<CompareMode>(() => (folder ? FOLDER_MODE : (special ?? { kind: simpleMode })), [folder, special, simpleMode]);
  const [layout, setLayout] = useStored<Layout>("layout", "split", ["split", "unified"]);
  const [sideWidth, setSideWidth] = useStoredNumber("sidebar", SIDE_WIDTH.initial, SIDE_WIDTH.min, SIDE_WIDTH.max);
  const [notesWidth, setNotesWidth] = useStoredNumber("notes-width", NOTES_WIDTH.initial, NOTES_WIDTH.min, NOTES_WIDTH.max);
  const [winWidth, setWinWidth] = useState(innerWidth);
  const side = Math.max(SIDE_WIDTH.min, Math.min(sideWidth, Math.round(winWidth / 2), winWidth - MIN_DIFF_WIDTH_PX));
  const [notesFile, setNotesFile] = useState<NotesFile | null>(null);
  const [notesPref, setNotesPref] = useStored<"on" | "off">("notes", "on", ["on", "off"]);
  const [stopAt, setStopAt] = useState<number | null>(null);
  const [briefShown, setBriefShown] = useState(false);
  const [briefEnded, setBriefEnded] = useState(false);
  const [captionOff, setCaptionOff] = useState(false);
  const agentNotes = notesFile?.notes?.chapters.length ? notesFile.notes : null;
  const [walkedNotes, setWalkedNotes] = useState(agentNotes);
  if (walkedNotes !== agentNotes) {
    setWalkedNotes(agentNotes);
    if (stopAt !== null) setStopAt(walkedNotes && agentNotes ? sameStop(walkedNotes, agentNotes, stopAt) : null);
  }
  const briefOpen = briefShown && !!agentNotes;
  const notesFit = winWidth - side - NOTES_WIDTH.min >= MIN_DIFF_WIDTH_PX;
  const [notesAnyway, setNotesAnyway] = useState(false);
  const walkRoom = winWidth - side - Math.min(notesWidth, Math.max(NOTES_WIDTH.min, winWidth - side - MIN_DIFF_WIDTH_PX)) >= WALK_MIN_DIFF_WIDTH_PX;
  if (notesAnyway && walkRoom) setNotesAnyway(false);
  const notesShown = !!agentNotes && notesPref === "on" && notesFit && (walkRoom || stopAt === null || notesAnyway);
  const notesOpen = notesShown && !briefOpen;
  const stops = useMemo(() => (agentNotes ? stopsOf(agentNotes) : []), [agentNotes]);
  const currentStop = stopAt !== null && stopAt < stops.length ? stopAt : null;
  const notesRoom = Math.max(NOTES_WIDTH.min, winWidth - side - MIN_DIFF_WIDTH_PX);
  const shownNotesWidth = Math.min(notesWidth, notesRoom);
  // The brief covers the panel for now, so the layout stays the one the diff comes back to.
  const narrow = winWidth - side - (notesShown ? shownNotesWidth : 0) < SPLIT_MIN_DIFF_WIDTH_PX;
  const [splitAnyway, setSplitAnyway] = useState(false);
  if (splitAnyway && !narrow) setSplitAnyway(false);
  const autoUnified = layout === "split" && narrow && !splitAnyway;
  const shownLayout: Layout = autoUnified ? "unified" : layout;
  const chooseLayout = useCallback(
    (next: Layout) => {
      setLayout(next);
      setSplitAnyway(next === "split");
    },
    [setLayout],
  );
  const [scope, setScope] = useStored<Scope>("scope", "changed", ["changed", "full"]);
  const [whitespacePref, setWhitespacePref] = useStored<"on" | "off">("ignore-whitespace", "off", ["on", "off"]);
  const ignoreWhitespace = whitespacePref === "on";
  const [previewPref, setPreviewPref] = useStored<"on" | "off">("preview", "off", ["on", "off"]);
  const [previewView, setPreviewView] = useStored<PreviewChoice>("markdownView", "auto", PREVIEW_CHOICES);
  const { themes, problems: themeProblems, warnings: themeWarnings } = usePresets();
  const [savedTheme, setTheme] = useStored<ThemeId>("theme", darkDesktop.matches ? "dark" : "light", isThemeId);
  const [savedLight, setLightTheme] = useStored<ThemeId>("theme-light", "light", isThemeId);
  const [savedDark, setDarkTheme] = useStored<ThemeId>("theme-dark", "dark", isThemeId);
  // A custom theme goes missing whenever its entry is mid-edit, so only what's shown falls back and the saved choice waits for it.
  const lightTheme = idsOf(themes, "light").includes(savedLight) ? savedLight : "light";
  const darkTheme = idsOf(themes, "dark").includes(savedDark) ? savedDark : "dark";
  const lastTone = savedTheme === savedDark ? "dark" : savedTheme === savedLight ? "light" : darkDesktop.matches ? "dark" : "light";
  // New installs follow the desktop; anyone who already has a saved theme keeps it until they opt in.
  const [followSystem, setFollowSystem] = useStored<"on" | "off">("theme-follow", localStorage.getItem("moire.theme") ? "off" : "on", ["on", "off"]);
  const systemTone = useSystemTone();
  // An edit can flip a custom theme's tone. Like a missing theme, it may be mid-edit, so its slot waits for it.
  const followed = followSystem === "on" && toneOf(savedTheme, themes) !== systemTone;
  const theme = idsOf(themes).includes(savedTheme) && !followed ? savedTheme : (followed ? systemTone : lastTone) === "dark" ? darkTheme : lightTheme;
  const pickTheme = (id: ThemeId) => {
    setTheme(id);
    (toneOf(id, themes) === "dark" ? setDarkTheme : setLightTheme)(id);
    if (toneOf(id, themes) !== systemTone) setFollowSystem("off");
  };
  const [cvd, setCvd] = useStored<"on" | "off">("cvd", "off", ["on", "off"]);
  const [codeFont, setCodeFont] = useStoredText("code-font");
  const [codeSize, setCodeSize] = useStoredNumber("code-size", CODE_SIZE.initial, CODE_SIZE.min, CODE_SIZE.max);
  const [hints, setHints] = useStored<"on" | "off">("hints", "off", ["on", "off"]);
  const [hideStaged, setHideStaged] = useStored<"on" | "off">("hide-staged", "off", ["on", "off"]);
  const [blink, setBlink] = useState<(Blink & { auto: boolean }) | null>(null);
  const [zoom, setZoom] = useState(1);
  const blinkRef = useRef(blink);
  blinkRef.current = blink;
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const [focusHunk, moveFocus] = useState(0);
  const [offHunk, setOffHunk] = useState(false);
  const belowHunks = useRef(false);
  const setFocusHunk = useCallback((hunk: number) => {
    setOffHunk(false);
    moveFocus(hunk);
  }, []);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [stubs, setStubs] = useState<Stub[]>([]);
  const [contents, setContents] = useState<{ key: string; data: FileContents } | null>(null);
  const [tokens, setTokens] = useState<{ key: string; data: [TokLines | null, TokLines | null] } | null>(null);
  const [picker, setPicker] = useState<PickerState>(null);
  const [themeMenu, setThemeMenu] = useState(false);
  const [quietNotices, setQuietNotices] = useState<ReadonlySet<string>>(new Set());
  const closeThemeMenu = useCallback(() => setThemeMenu(false), []);
  const [toast, setToast] = useState<ToastMsg | null>(null);
  const keymap = useKeymap();
  const keymapRef = useRef(keymap);
  keymapRef.current = keymap;
  const k = (id: CommandId) => keyText(keymap, id);
  const [help, setHelp] = useState(false);
  const closeHelp = useCallback(() => setHelp(false), []);
  const [palette, setPalette] = useState(false);
  const closePalette = useCallback(() => setPalette(false), []);
  const shownFiles = useRef<string[]>([]);
  const viewRef = useRef<DiffViewHandle>(null);
  const spots = useRef(new Map<string, { hunk?: Hunk; at: Spot | null }>());
  const undoSpots = useRef(new Map<string, { to: CompareMode["kind"]; path: string; line: number }>());
  const pendingFocus = useRef<"first" | "last" | null>(null);
  const restoreFile = useRef<string | null>(null);
  const contentCache = useRef(new Map<string, FileContents>());
  const tokenCache = useRef(new Map<string, [TokLines | null, TokLines | null]>());

  const [storedView, setFilesView] = useStored<FilesView>("files", "changed", ["changed", "all"]);
  const [stayInAll, setStayInAll] = useState(false);
  const filesView: FilesView = folder || stayInAll ? "all" : storedView;
  const browsing = useRef(filesView === "all");
  browsing.current = filesView === "all";
  const arrive = useRef<{
    to: CompareMode["kind"];
    path: string;
    line: number | null;
    onOldSide: boolean;
    note: boolean;
    undone?: boolean;
    from?: string | null;
  } | null>(null);
  const landing = useRef<{ to: CompareMode["kind"]; path: string; line: number; onOldSide: boolean; undone?: boolean } | null>(null);
  const [landed, setLanded] = useState(0);
  const hidden = useCallback((m: CompareMode, f: FileDiff) => m.kind === "all" && hideStaged === "on" && f.staged === "full", [hideStaged]);
  const visible = (m: CompareMode, files: FileDiff[]) => orderFiles(files).filter((f) => !hidden(m, f));
  const { mode, diff, loadedAt, fresh, refreshTick, refresh, reset, busy, acting, startActing, settle } = useDiff(repo, wantMode, ignoreWhitespace, {
    async prefetch(root, m, result) {
      const open = result.files.find((f) => f.path === activeRef.current);
      const openKey = open && fileKeyOf(JSON.stringify(m), open);
      if (!open || !openKey || open.binary || open.tooLarge || contentCache.current.has(openKey)) return;
      const data = await window.moire.fileContents(root, m, open).catch(() => null);
      if (data) remember(contentCache.current, openKey, data);
    },
    loaded(result, m, sameView) {
      if (!!result.repo.folder !== folder) {
        setStayInAll(folder);
        setRepo(result.repo);
      }
      setError(null);
      const ordered = visible(m, result.files);
      const has = (p: string | null) => ordered.some((f) => f.path === p);
      const wanted = localStorage.getItem("moire.file") ?? restoreFile.current;
      localStorage.removeItem("moire.file");
      restoreFile.current = null;
      // A load that started before the undo landed doesn't have its hunk back yet; the settling one will.
      const early = !!arrive.current?.undone && acting.current;
      const left = !!arrive.current?.undone && arrive.current.from !== activeRef.current;
      const land = !early && !left && arrive.current?.to === m.kind ? arrive.current : null;
      if (!early) arrive.current = null;
      if (land?.line != null && has(land.path)) {
        landing.current = { to: m.kind, path: land.path, line: land.line, onOldSide: land.onOldSide, undone: land.undone };
        setLanded((n) => n + 1);
      }
      if (land?.note && !has(land.path)) {
        setToast({
          text: ignoreWhitespace ? `Whitespace is hidden, so ${land.path} has nothing to show` : `${land.path} has no changes in Unstaged or Staged`,
          undo: false,
        });
      }
      setActive((cur) => {
        const kept = [land?.path ?? null, cur, wanted].find(has);
        if (kept) return kept;
        if (cur && browsing.current && (!sameView || !shownFiles.current.includes(cur))) return cur;
        if (!sameView) return ordered[0]?.path ?? null;
        const prev = shownFiles.current;
        return prev.slice(prev.indexOf(cur!) + 1).find(has) ?? ordered.at(-1)?.path ?? null;
      });
    },
    switched(result, m) {
      if (browsing.current) return;
      const ordered = visible(m, result.files);
      const land = arrive.current?.to === m.kind ? arrive.current.path : null;
      setActive((cur) => [land, cur].find((p) => ordered.some((f) => f.path === p)) ?? ordered[0]?.path ?? null);
    },
    error: (e) => setError(message(e)),
  });
  const modeKey = JSON.stringify(mode);
  const tree = useTree(repo, mode, modeKey, refreshTick, filesView === "all", (e) => setError(message(e)));
  const [browsed, setBrowsed] = useState<ReadonlyMap<string, FileContents>>(new Map());
  const changedFile = diff?.files.find((f) => f.path === active) ?? null;
  const browsedData = !changedFile && active ? browsed.get(`${modeKey}:${active}`) : undefined;
  const browsedFile = useMemo(
    (): FileDiff | null =>
      active && browsedData
        ? {
            path: active,
            status: "unchanged",
            binary: !!browsedData.binary,
            tooLarge: browsedData.hidden && !browsedData.binary,
            blobs: hashString(JSON.stringify(browsedData)),
            additions: 0,
            deletions: 0,
            hunks: [],
          }
        : null,
    [active, browsedData],
  );
  const want = changedFile ?? browsedFile;
  const wantKey = useMemo(() => (want ? fileKeyOf(modeKey, want) : null), [want, modeKey]);
  const files = useMemo(() => orderFiles(diff?.files ?? []), [diff]);
  shownFiles.current = files.map((f) => f.path);
  const browsedSearch = useMemo(() => (browsedFile && browsedData ? { file: browsedFile, contents: browsedData } : null), [browsedFile, browsedData]);
  const search = useSearch(repo, mode, modeKey, files, active, browsedSearch, (e) => setError(message(e)));

  const [upstream, setUpstream] = useState<Upstream | null>(null);
  useEffect(() => {
    if (!repo) return;
    let stale = false;
    const keep = (next: Upstream | null) => !stale && setUpstream((cur) => (JSON.stringify(cur) === JSON.stringify(next) ? cur : next));
    window.moire.upstream(repo.root).then(keep, () => keep(null));
    return () => {
      stale = true;
    };
  }, [repo, refreshTick]);

  const notesProblem = useRef("");
  const notesFor = mode.kind === "commit" ? mode.sha : mode.kind === "branches" ? modeKey : "working";
  useEffect(() => {
    setStopAt(null);
    setBriefShown(false);
    if (mode.kind === "branches") setNotesFile(null);
  }, [notesFor]);
  const walkKey = repo && agentNotes ? `${repo.root}:${notesFor}:${hashString(shapeOf(agentNotes))}` : null;
  useEffect(() => {
    // Notes can beat the diff here, and a file this view doesn't list would leave the pane empty.
    const saved = diff && walkKey && stopAt === null ? savedStop(walkKey) : null;
    if (saved === null || saved >= stops.length) return;
    setStopAt(saved);
    const path = rangeAt(saved)?.path;
    if (path && !visible(mode, diff!.files).some((f) => f.path === path)) return;
    // Landing moves the focus too, or s and x would act on a hunk the caption isn't about.
    pendingNote.current = saved;
    setNoteTick((t) => t + 1);
    if (path) setActive(path);
  }, [walkKey, !!diff]);
  useEffect(() => {
    if (walkKey && stopAt !== null) saveStop(walkKey, stopAt);
  }, [walkKey, stopAt]);
  useEffect(() => {
    if (!repo) return;
    let stale = false;
    const read =
      mode.kind === "branches" ? window.moire.rangeNotes(repo.root, mode) : window.moire.notes(repo.root, notesFor === "working" ? undefined : notesFor);
    read.then(
      (next) => {
        if (stale) return;
        setNotesFile((cur) => (JSON.stringify(cur) === JSON.stringify(next) ? cur : next));
        const problem = next.problem ?? "";
        if (problem && problem !== notesProblem.current) setToast({ text: problem, undo: false });
        notesProblem.current = problem;
      },
      (e) => !stale && setError(message(e)),
    );
    return () => {
      stale = true;
    };
  }, [repo, refreshTick, notesFor]);

  useLayoutEffect(() => {
    if (followSystem !== "on") return;
    setTheme(systemTone === "dark" ? savedDark : savedLight);
  }, [followSystem, systemTone, savedDark, savedLight, setTheme]);

  useEffect(() => {
    document.title = repo ? `${repo.name} - Moire` : "Moire";
  }, [repo]);

  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme;
    root.dataset.tone = toneOf(theme, themes);
    if (theme === savedTheme && theme !== savedLight && theme !== savedDark) (toneOf(theme, themes) === "dark" ? setDarkTheme : setLightTheme)(theme);
    root.dataset.cvd = cvd;
    const css = getComputedStyle(root);
    void window.moire.setTheme(css.getPropertyValue("--frame").trim(), css.getPropertyValue("--graphite").trim());
  }, [theme, savedTheme, savedLight, savedDark, themes, cvd, setDarkTheme, setLightTheme]);

  useEffect(() => {
    document.documentElement.dataset.layout = shownLayout;
  }, [shownLayout]);

  useEffect(() => {
    document.documentElement.dataset.hints = hints;
  }, [hints]);

  useEffect(() => {
    const { style } = document.documentElement;
    const name = codeFont.replace(/["\\;]/g, "").trim();
    if (name) style.setProperty("--diff-font", `"${name}", var(--code)`);
    else style.removeProperty("--diff-font");
    style.setProperty("--diff-size", `${codeSize}px`);
    style.setProperty("--row", `${Math.round(codeSize * 1.4)}px`);
  }, [codeFont, codeSize]);

  useEffect(() => {
    document.documentElement.style.setProperty("--side", `${side}px`);
    document.documentElement.style.setProperty("--notes", `${shownNotesWidth}px`);
  }, [side, shownNotesWidth]);

  useEffect(() => {
    const onResize = () => setWinWidth(innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    restoreFile.current = repo ? (openFiles()[repo.root] ?? null) : null;
  }, [repo?.root]);

  useEffect(() => {
    if (repo && active) rememberFile(repo.root, active);
  }, [repo, active]);

  useEffect(() => {
    void window.moire.zoom().then(setZoom);
    return window.moire.onZoom((factor) => {
      setZoom(factor);
      const reset = keyText(keymapRef.current, "zoomReset");
      setToast({ text: `Zoom ${Math.round(factor * 100)}%${factor === 1 ? "" : `. ${reset} resets it.`}`, undo: false });
    });
  }, []);

  useEffect(() => {
    let reported = "";
    const load = () => {
      window.moire.keys().then(
        ({ keys, problems }) => {
          setKeymap(buildKeymap(keys));
          const text = problems.join(" ");
          if (text && text !== reported) setToast({ text: `keys.json: ${text}`, undo: false });
          reported = text;
        },
        (e) => setError(message(e)),
      );
    };
    load();
    return window.moire.onKeysChanged(load);
  }, []);

  useEffect(() => {
    const [first, ...rest] = themeProblems;
    const warned = themes.filter((t) => themeWarnings[t.id]).map((t) => t.name);
    if (first)
      setToast({ text: rest.length ? `themes.json has ${rest.length + 1} problems. The theme menu lists them.` : `themes.json: ${first}`, undo: false });
    else if (warned.length) setToast({ text: `${warned.join(", ")} may be hard to read. The theme menu says why.`, undo: false });
  }, [themeProblems, themeWarnings]);

  useEffect(() => {
    window.moire
      .initialRepo()
      .then(setRepo, (e) => setError(message(e)))
      .finally(() => setBooting(false));
  }, []);

  useEffect(() => {
    setBlink((b) => (b && b.hunk === focusHunk ? b : null));
  }, [focusHunk]);

  useEffect(() => {
    if (!blink?.auto) return;
    const timer = setInterval(() => setBlink((b) => b && { ...b, plate: b.plate === "a" ? "b" : "a" }), BLINK_MS);
    return () => clearInterval(timer);
  }, [blink?.auto, blink?.hunk]);

  const inDiff = !!changedFile;
  useEffect(() => {
    if (!repo || !active || !diff || inDiff || filesView !== "all") return;
    let stale = false;
    const key = `${modeKey}:${active}`;
    window.moire.fileContents(repo.root, mode, { path: active, status: "unchanged" }).then(
      (data) =>
        !stale &&
        setBrowsed((cur) => {
          const have = cur.get(key);
          if (have && have.a === data.a && have.b === data.b && have.hidden === data.hidden && have.binary === data.binary) return cur;
          const next = new Map(cur);
          remember(next, key, data);
          return next;
        }),
      (e) => !stale && setError(message(e)),
    );
    return () => {
      stale = true;
    };
  }, [repo, active, modeKey, refreshTick, !!diff, inDiff, filesView]);

  const wantContents = wantKey
    ? contents?.key === wantKey
      ? contents.data
      : (contentCache.current.get(wantKey) ?? search.contents.get(wantKey) ?? (want === browsedFile ? browsedData : null) ?? null)
    : null;
  useEffect(() => {
    if (!repo || !want || !wantKey || want.binary || want.tooLarge || wantContents) return;
    let stale = false;
    window.moire.fileContents(repo.root, mode, want).then(
      (data) => {
        remember(contentCache.current, wantKey, data);
        if (!stale) setContents({ key: wantKey, data });
      },
      (e) => !stale && setError(message(e)),
    );
    return () => {
      stale = true;
    };
  }, [wantKey]);

  const lastTokens = useRef<{ path: string; data: [TokLines | null, TokLines | null] } | null>(null);
  const cachedTokens = wantKey ? (tokens?.key === wantKey ? tokens.data : tokenCache.current.get(wantKey)) : undefined;
  if (cachedTokens && want) lastTokens.current = { path: want.path, data: cachedTokens };
  const wantTokens = cachedTokens ?? (want && lastTokens.current?.path === want.path ? lastTokens.current.data : null);
  useEffect(() => {
    if (!want || !wantKey || !wantContents || wantContents.hidden || tokenCache.current.has(wantKey)) return;
    const abort = new AbortController();
    const onPartial = (data: [TokLines | null, TokLines | null]) => !abort.signal.aborted && setTokens({ key: wantKey, data });
    void highlight(langFor(want.path, wantContents.b ?? wantContents.a), wantContents.a, wantContents.b, { signal: abort.signal, onPartial }).then((data) => {
      if (!data) return;
      remember(tokenCache.current, wantKey, data);
      if (!abort.signal.aborted) setTokens({ key: wantKey, data });
    });
    return () => abort.abort();
  }, [wantKey, wantContents]);

  const browsePending = !want && !!active && !!diff && !inDiff && filesView === "all";
  const wantReady = want ? want.binary || !!want.tooLarge || (!!wantContents && (wantContents.hidden || !!wantTokens)) : !browsePending;
  const [late, setLate] = useState<string | null>(null);
  useEffect(() => {
    if (wantReady || !wantKey) return;
    const timer = setTimeout(() => setLate(wantKey), PREV_FILE_HOLD_MS);
    return () => clearTimeout(timer);
  }, [wantKey, wantReady]);
  const held = useRef<Shown | null>(null);
  const live: Shown | null = repo && want && wantKey ? { root: repo.root, file: want, key: wantKey, contents: wantContents, tokens: wantTokens } : null;
  const keep = held.current?.root === repo?.root ? held.current : null;
  const shown = wantReady || (!!wantKey && late === wantKey) || !keep || keep.key === wantKey ? live : keep;
  held.current = shown;
  const file = shown?.file ?? null;
  const fileKey = shown?.key ?? null;
  const fileContents = shown?.contents ?? null;
  const fileTokens = shown?.tokens ?? null;

  const shownView = `${modeKey}:${ignoreWhitespace}:${file?.path}`;
  const [resetFor, setResetFor] = useState(shownView);
  const shownRef = useRef(shownView);
  shownRef.current = shownView;
  const spotKey = `${repo?.root}:${shownView}`;
  if (resetFor !== shownView) {
    setResetFor(shownView);
    setExpanded(new Set());
    const saved = spots.current.get(spotKey)?.hunk;
    moveFocus(saved && file ? followHunk(saved, file.hunks) : 0);
    setOffHunk(false);
    setBlink(null);
    setStubs([]);
  }

  const focused = useRef<{ view: string; path: string; hunk: Hunk; index: number } | null>(null);
  const actedOn = useRef<{ view: string; hunk: Hunk; next: number; left: number } | null>(null);
  const stopStagedFrom = useRef<number | null>(null);
  // Layout effect: a queued press mustn't see the new hunks with the old cursor.
  useLayoutEffect(() => {
    const prev = focused.current;
    if (!file || !prev || prev.path !== file.path || file.hunks[focusHunk] === prev.hunk || !file.hunks.length) return;
    const on = actedOn.current;
    const gone = (h: Hunk) => !file.hunks.some((f) => f.oldStart === h.oldStart && hunkChanges(f) === hunkChanges(h));
    const acted =
      on?.view === shownRef.current &&
      on.hunk.oldStart === prev.hunk.oldStart &&
      on.hunk.newStart === prev.hunk.newStart &&
      file.hunks.length <= on.left &&
      gone(on.hunk)
        ? on
        : null;
    if (acted) actedOn.current = null;
    if (acted && acted.next >= file.hunks.length) queued.current = [];
    // A press batched with a reload has already moved the cursor; prev is the hunk it left.
    const moved = prev.view === shownRef.current && prev.index !== focusHunk;
    const next = acted ? Math.min(acted.next, file.hunks.length - 1) : moved ? Math.min(focusHunk, file.hunks.length - 1) : followHunk(prev.hunk, file.hunks);
    if (acted) requestAnimationFrame(() => viewRef.current?.showHunk?.(next));
    if (next === focusHunk) return;
    moveFocus(next);
    setBlink((b) => b && { ...b, hunk: next });
  }, [file]);
  useEffect(() => {
    if (file) remember(spots.current, spotKey, { at: spots.current.get(spotKey)?.at ?? null, hunk: file.hunks[focusHunk] });
  }, [spotKey, file, focusHunk]);
  useEffect(() => {
    const hunk = file?.hunks[focusHunk];
    focused.current = file && hunk ? { view: shownRef.current, path: file.path, hunk, index: focusHunk } : null;
  }, [file, focusHunk]);

  const previewable = useMemo(() => (file ? previewOf(file) : null), [file]);
  const undecoded = useMemo(() => !!file && notUtf8(file, fileContents), [file, fileContents]);
  const diffVersion = diff?.version ?? "";
  const preview: Preview | null =
    repo && fileKey && previewable && (previewable.forced || previewPref === "on")
      ? {
          kind: previewable.kind,
          root: repo.root,
          mode,
          version: previewable.kind === "markdown" ? diffVersion : fileKey,
          text: fileContents ? (fileContents.b ?? fileContents.a) : null,
          old: fileContents?.a ?? null,
          view: previewView,
        }
      : null;
  const readingMarkdown = preview?.kind === "markdown" && (previewView === "read" || readOnly(file!, preview.text, preview.old));
  const togglePreview = useCallback(() => setPreviewPref((p) => (p === "on" ? "off" : "on")), [setPreviewPref]);

  const blinkHunk = blink?.hunk;
  const rows = useMemo(
    () => (file ? withStubs(buildRows(file, fileContents, { layout: shownLayout, scope, expanded, plates: blinkHunk }), file, stubs) : []),
    [file, fileContents, shownLayout, scope, expanded, blinkHunk, stubs],
  );
  const hunkRows = useMemo(() => rows.flatMap((r, i) => (r.t === "hunk" ? [i] : [])), [rows]);
  const bLines = useMemo(() => splitLines(fileContents?.b ?? null), [fileContents]);
  const fileMarks = useMemo(() => {
    if (!agentNotes || !file) return null;
    const marks: Mark[] = [];
    stops.forEach(({ chapter, range }, stop) => {
      const r = agentNotes.chapters[chapter].ranges[range];
      if (r.path !== file.path) return;
      const at = placeRange(r, bLines);
      if (at !== "all" && at !== "lost") marks.push({ ...at, chapter, stop, lead: leadOf(stops, stop), title: agentNotes.chapters[chapter].title });
    });
    return marks.length ? marks : null;
  }, [agentNotes, stops, file, bLines]);

  const pendingReveal = useRef<Hit | null>(null);
  const [, setRevealing] = useState(0);
  const reveal = file && pendingReveal.current?.path === file.path ? pendingReveal.current : null;
  const revealRow = reveal ? hitRow(rows, reveal) : -1;
  if (reveal && revealRow < 0) {
    const keys = hitKeys(rows, reveal);
    if (keys.length && !keys.every((k) => expanded.has(k))) setExpanded((cur) => new Set([...cur, ...keys]));
  }

  useEffect(() => {
    moveFocus((f) => Math.min(f, Math.max(0, hunkRows.length - 1)));
    setBlink((b) => (b && b.hunk < hunkRows.length ? b : null));
    const land = landing.current;
    if (land && file && fileKey === wantKey && hunkRows.length && land.path === file.path && land.to === mode.kind) {
      landing.current = null;
      const dist = (h: Hunk) => Math.abs((land.onOldSide ? h.oldStart : h.newStart) - land.line);
      const near = file.hunks.reduce((best, h, i) => (dist(h) < dist(file.hunks[best]) ? i : best), 0);
      setFocusHunk(near);
      const keepSpot = !land.undone && !!spots.current.get(spotKey)?.at;
      requestAnimationFrame(() => (keepSpot ? viewRef.current?.showHunk?.(near) : viewRef.current?.scrollToRow(hunkRows[near])));
      return;
    }
    if (!pendingFocus.current || !hunkRows.length) return;
    const target = pendingFocus.current === "first" ? 0 : hunkRows.length - 1;
    pendingFocus.current = null;
    setFocusHunk(target);
    requestAnimationFrame(() => viewRef.current?.scrollToRow(hunkRows[target]));
  }, [hunkRows, landed]);

  const [filters, setFilters] = useState<Record<FilesView, string>>({ changed: "", all: "" });
  const setFilter = useCallback((text: string) => setFilters((cur) => ({ ...cur, [filesView]: text })), [filesView]);
  const filter = filters.changed;
  const filterInput = useRef<HTMLInputElement>(null);
  const listed = useMemo(() => files.filter((f) => (!filter || fuzzyMatch(filter, f.path)) && !hidden(mode, f)), [files, filter, hidden, mode]);
  const showFiles = useCallback(
    (view: FilesView) => {
      if (folder) return;
      setStayInAll(false);
      setFilesView(view);
      if (view === "changed" && !files.some((f) => f.path === activeRef.current)) setActive(listed[0]?.path ?? null);
    },
    [folder, files, listed, setFilesView],
  );
  const [folderReveal, setFolderReveal] = useState<Reveal | null>(null);
  const revealFolder = useCallback(
    (dir: string) => {
      setFilters((cur) => ({ ...cur, all: "" }));
      showFiles("all");
      setFolderReveal({ dir, at: performance.now() });
    },
    [showFiles],
  );
  useEffect(() => {
    for (const f of files) if (!f.binary) warm(langFor(f.path));
  }, [files]);

  useEffect(() => {
    if (!repo || !want || !wantReady) return;
    const at = listed.findIndex((f) => f.path === want.path);
    if (at < 0) return;
    const abort = new AbortController();
    for (const f of [listed[at + 1], listed[at - 1]]) {
      if (!f || f.binary || f.tooLarge) continue;
      const key = fileKeyOf(modeKey, f);
      if (tokenCache.current.has(key)) continue;
      const have = contentCache.current.get(key) ?? search.contents.get(key);
      const read = have ? Promise.resolve(have) : window.moire.fileContents(repo.root, mode, f);
      read
        .then((data) => {
          remember(contentCache.current, key, data);
          return abort.signal.aborted || data.hidden
            ? null
            : highlight(langFor(f.path, data.b ?? data.a), data.a, data.b, { signal: abort.signal, background: true });
        })
        .then((data) => data && remember(tokenCache.current, key, data))
        .catch(() => {});
    }
    return () => abort.abort();
  }, [wantKey, wantReady, listed]);

  const pendingNote = useRef<number | null>(null);
  const [noteTick, setNoteTick] = useState(0);
  useEffect(() => {
    const at = pendingNote.current;
    const stop = at === null ? null : stops[at];
    const range = stop && agentNotes?.chapters[stop.chapter].ranges[stop.range];
    if (!stop || !range || !file || file.path !== range.path || (range.code && !fileContents && !file.binary && !file.tooLarge)) return;
    const placed = placeRange(range, bLines);
    const index = placed !== "all" && placed !== "lost" ? rowOfLine(rows, placed.start) : (hunkRows[0] ?? 0);
    if (placed !== "all" && placed !== "lost" && index < 0) {
      const keys = lineKeys(rows, file.hunks, placed.start);
      pendingNote.current = keys.length && !keys.every((k) => expanded.has(k)) ? at : null;
      if (pendingNote.current !== null) setExpanded((cur) => new Set([...cur, ...keys]));
      return;
    }
    pendingNote.current = null;
    if (placed === "lost") notify(`Chapter ${stop.chapter + 1}'s lines in ${range.path.split("/").pop()} changed since it was written`);
    const row = rows[index];
    if (row && "hunk" in row && row.hunk >= 0) setFocusHunk(row.hunk);
    else if (placed !== "all" && placed !== "lost" && file.hunks.length) {
      const { hunk, inside, below } = hunkAt(file.hunks, placed);
      moveFocus(hunk);
      setOffHunk(!inside);
      belowHunks.current = below;
    }
    requestAnimationFrame(() => viewRef.current?.scrollToRow(preview ? index : rowToShow(rows, index), "start"));
  }, [rows, file, fileContents, noteTick]);

  const allHidden = files.length > 0 && files.every((f) => hidden(mode, f));
  const hideStagedFiles = (hide: boolean) => {
    setHideStaged(hide ? "on" : "off");
    if (hide && changedFile?.staged === "full") setActive(files.find((f) => f.staged !== "full")?.path ?? null);
  };
  const [repoPicker, setRepoPicker] = useState(false);
  const [editorPicker, setEditorPicker] = useState<{ path?: string; line: number } | null>(null);
  const closeRepoPicker = useCallback(() => setRepoPicker(false), []);
  const [menu, setMenu] = useState<MenuAt | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({});
  const draft = drafts[repo?.root ?? ""] ?? "";
  const setDraft = useCallback((text: string) => repo && setDrafts((cur) => ({ ...cur, [repo.root]: text })), [repo]);
  const [commitError, setCommitError] = useState<{ root: string; text: string } | null>(null);
  const [committed, setCommitted] = useState<string | null>(null);
  const commitInput = useRef<HTMLTextAreaElement>(null);
  const focusCommit = useRef(false);

  const { selection, col: selCol, wholeSide, fromHunkHeaders, select, selectAll, pick, extend, clear, carry } = useSelection(rows);
  const wholeHunks = !!wholeSide || fromHunkHeaders;
  const [selectedIn, setSelectedIn] = useState({ key: fileKey, view: shownView, rows });
  if (selectedIn.rows !== rows) {
    if (selectedIn.key !== fileKey && !(wholeSide && selectedIn.view === shownView))
      carry(selectedIn.view === shownView && selection.size ? carryKeys(selectedIn.rows, rows, selection) : null);
    setSelectedIn({ key: fileKey, view: shownView, rows });
  }
  const selectLine = useCallback(
    (key: string, col: Col, how: SelectHow) => {
      select(key, col, how);
      const hunk = hunkOfKey(key);
      if (hunk !== null) setFocusHunk(hunk);
    },
    [select],
  );

  const searchInput = useRef<HTMLInputElement>(null);
  const openSearch = useCallback(() => {
    search.setOpen(true);
    requestAnimationFrame(() => {
      searchInput.current?.focus();
      searchInput.current?.select();
    });
  }, [search.setOpen]);
  const closeSearch = useCallback(() => {
    search.setOpen(false);
    searchInput.current?.blur();
  }, [search.setOpen]);
  const searchHeight = useRef(0);
  useLayoutEffect(() => {
    const height = search.open ? (searchInput.current?.closest<HTMLElement>(".search")?.offsetHeight ?? 0) : 0;
    const el = viewRef.current?.scroller();
    if (el) el.scrollTop += height - searchHeight.current;
    searchHeight.current = height;
  }, [search.open]);

  useEffect(() => {
    if (!search.revealTick || !search.current) return;
    pendingReveal.current = search.current;
    if (search.current.path !== active) setActive(search.current.path);
    else setRevealing((n) => n + 1);
  }, [search.revealTick]);

  useEffect(() => {
    const hit = pendingReveal.current;
    if (!hit || hit.path !== file?.path) return;
    const index = hitRow(rows, hit);
    const row = rows[index];
    if (row?.t !== "split" && row?.t !== "uni") return;
    pendingReveal.current = null;
    if (row.hunk >= 0) setFocusHunk(row.hunk);
    requestAnimationFrame(() => viewRef.current?.scrollToRow(index, "center"));
  }, [rows, file, search.revealTick]);

  const actions = !ignoreWhitespace && (mode.kind === "unstaged" || mode.kind === "staged") ? mode.kind : null;
  const stageOff = ignoreWhitespace ? `Turn off Ignore whitespace (${k("ignoreWhitespace")}) to stage or discard, so nothing changes that you can't see` : null;
  const notify = useCallback((text: string, undo = false) => setToast({ text, undo }), []);
  const addToToast = useCallback((text: string) => {
    setToast((cur) => (cur ? { ...cur, text: `${cur.text.replace(/\.?$/, ".")} ${text}` } : { text, undo: false }));
  }, []);
  const writable = !folder && diff?.b.kind === "worktree";
  const filesIn = useFilesIn({ repo, writable, tree, view: filesView, onView: showFiles, open: active, notify, startActing, settle });
  const dropDir = filesIn.clash?.plan.dir ?? filesIn.drag?.target ?? null;
  const dropIgnored = dropDir !== null && isIgnored(tree, dropDir);
  const sideTree = useMemo(() => ghostTree(tree, filesIn.clash), [tree, filesIn.clash]);

  const queued = useRef<{ action: StageAction; root: string; mode: "unstaged" | "staged"; path: string }[]>([]);
  const refsFor = (target: number | "file" | null, keys: ReadonlySet<string>, hunk = focusHunk): LineRef[] | null => {
    if (!file || target === "file" || !file.hunks.length || (file.noise && !expanded.has("noise")) || preview?.kind === "image") return null;
    const picked = changedRefs(file, keys).filter((r) => target === null || r.hunk === target);
    const widened = wholeHunks ? [...new Set(picked.map((r) => r.hunk))].flatMap((h) => hunkRefs(file, h)) : picked;
    return widened.length ? widened : hunkRefs(file, target ?? hunk);
  };
  const send = async (action: StageAction, file: FileDiff, lines: LineRef[] | null) => {
    if (!repo || !actions) return;
    const whole = lines ? [...new Set(lines.map((r) => r.hunk))].filter((h) => lines.filter((r) => r.hunk === h).length === hunkRefs(file, h).length) : [];
    // Set before act(): the watcher can deliver the new diff first.
    actedOn.current = whole.includes(focusHunk)
      ? { view: shownView, hunk: file.hunks[focusHunk], next: focusHunk - whole.filter((h) => h < focusHunk).length, left: file.hunks.length - whole.length }
      : null;
    startActing();
    const view = shownView;
    const undoId = crypto.randomUUID();
    const hunk = file.hunks[lines?.[0]?.hunk ?? focusHunk];
    if (hunk) remember(undoSpots.current, undoId, { to: mode.kind, path: file.path, line: hunk.newStart });
    try {
      notify(await window.moire.act(repo.root, { mode: actions, action, file, lines, undoId }), true);
      if (action === "stage" && notesOpen && currentStop !== null && stagedStops.get(currentStop) !== "full") stopStagedFrom.current = currentStop;
      const added = (action === "stage" ? whole : []).map((h): Stub => {
        const { newStart, oldStart, oldLines } = file.hunks[h];
        return { treeLine: newStart, indexLine: oldLines ? oldStart : oldStart + 1, count: hunkRefs(file, h).length, undoId, undoable: true };
      });
      if (shownRef.current === view) setStubs((cur) => [...outdated(cur), ...added]);
    } catch (e) {
      queued.current = [];
      actedOn.current = null;
      notify(message(e));
    }
    clear();
    settle();
  };
  const act = async (action: StageAction, target: number | "file" | null, press?: (typeof queued.current)[number]) => {
    if (!repo || !file || !actions) return;
    if (wholeSide && target === null) target = "file";
    if (press && (press.root !== repo.root || press.mode !== actions || press.path !== file.path)) {
      queued.current = [];
      return;
    }
    // A step lands a moment after its press, and until then the focus is the last step's.
    if (target === null && pendingNote.current !== null && rangeAt(pendingNote.current)?.path === active) return;
    if (offHunk && target === null && !selection.size)
      return notify(`This step is on unchanged lines, so there's nothing here to ${action}. ${k("nextHunk")} goes to the nearest hunk.`);
    if (acting.current) {
      const keepsMeaningWhenQueued = target === null && action !== "discard" && !selection.size;
      if (keepsMeaningWhenQueued) queued.current.push({ action, root: repo.root, mode: actions, path: file.path });
      return;
    }
    if (file.status === "unchanged") return notify(`${file.path.split("/").pop()} has no changes here`);
    const lines = refsFor(target, selection);
    if (lines && target === null && selection.size && !changedRefs(file, selection).length) return notify("No changed lines selected");
    await send(action, file, lines);
  };
  const actRef = useRef(act);
  actRef.current = act;
  const onAct = useCallback((action: StageAction, target: number | "file" | null) => actRef.current(action, target), []);
  useEffect(() => {
    if (busy || !queued.current.length || file !== want) return;
    const timer = setTimeout(() => {
      const next = queued.current.shift();
      if (next) void actRef.current(next.action, null, next);
    });
    return () => clearTimeout(timer);
  }, [busy, file, want, focusHunk]);

  const actAll = async () => {
    if (stageOff) return notify(stageOff);
    if (!repo || !actions || acting.current) return;
    if (!listed.length) return notify(`Nothing to ${actions === "staged" ? "unstage" : "stage"}`);
    startActing();
    try {
      notify(await window.moire.actAll(repo.root, { mode: actions, files: listed }), true);
      setStubs(outdated);
    } catch (e) {
      notify(message(e));
    }
    clear();
    settle();
  };
  const actAllRef = useRef(actAll);
  actAllRef.current = actAll;
  const toggleStageAll = useCallback(() => actAllRef.current(), []);
  const discardFile = useCallback(
    () => (actions === "unstaged" ? onAct("discard", "file") : notify("Discard works in the Unstaged view (1)")),
    [actions, onAct, notify],
  );
  const allLabel = (verb: string) => (listed.length === files.length ? `${verb} all` : `${verb} ${listed.length} shown`);

  const toggleBlink = useCallback(
    (hunk: number) => {
      if (blinkRef.current?.hunk === hunk) return setBlink(null);
      const auto = !matchMedia("(prefers-reduced-motion: reduce)").matches;
      setFocusHunk(hunk);
      setBlink({ hunk, plate: "b", auto });
      const [hold, stop, toggle] = (["blinkHold", "cancel", "blink"] as const).map((id) => keyText(keymapRef.current, id));
      notify(
        auto
          ? `Blinking between plate A and B. Hold ${hold} to flip by hand, ${stop} or ${toggle} stops.`
          : `Hold ${hold} for plate A, let go for plate B. ${stop} stops.`,
      );
    },
    [notify],
  );
  const holdBlink = useCallback(() => {
    if (!hunkRows.length) return;
    const [hold, stop] = (["blinkHold", "cancel"] as const).map((id) => keyText(keymapRef.current, id));
    if (!blinkRef.current) notify(`Plate A while ${hold} is held, plate B when you let go. ${stop} stops.`);
    setBlink({ hunk: focusHunk, plate: "a", auto: false });
  }, [focusHunk, hunkRows, notify]);
  useEffect(() => {
    const onUp = (event: KeyboardEvent) => {
      if (sameKey(strokeOf(event, MAC), keymapRef.current.keys.blinkHold[0])) setBlink((b) => (b && !b.auto ? { ...b, plate: "b" } : b));
    };
    window.addEventListener("keyup", onUp);
    return () => window.removeEventListener("keyup", onUp);
  }, []);

  const sideLines = useMemo(() => ({ a: copySide(fileContents, "a")?.count ?? null, b: copySide(fileContents, "b")?.count ?? null }), [fileContents]);
  const copiedFile = (name: string | undefined, count: number) => notify(`Copied ${name}, ${count} ${count === 1 ? "line" : "lines"}`);
  const copyWhole = (side: "a" | "b") => {
    const picked = copySide(fileContents, side);
    if (!file || !picked) return notify("This side has no text to copy");
    const name = (side === "a" ? (file.oldPath ?? file.path) : file.path).split("/").pop();
    window.moire.copy(picked.text).then(
      () => copiedFile(name, picked.count),
      (e) => notify(message(e)),
    );
  };
  const copyWholeRef = useRef(copyWhole);
  copyWholeRef.current = copyWhole;
  const onCopySide = useCallback((side: "a" | "b") => copyWholeRef.current(side), []);
  const copy = (format: "code" | "markdown", hunk?: number) => {
    if (format === "code" && hunk === undefined && wholeSide) return copyWhole(wholeSide);
    let picked = hunk === undefined ? selection : new Set([...selection].filter((key) => key.startsWith(`${hunk}:`)));
    const focused = file?.hunks[focusHunk];
    if (!picked.size && format === "markdown" && focused) picked = new Set(focused.lines.map((_, i) => lineKey(focusHunk, i)));
    if (!file || !diff || !picked.size) {
      if (format === "markdown") notify("Select lines first: click or drag their line numbers");
      return;
    }
    const { text, count } = format === "code" ? copyCode(file, fileContents, expanded, picked) : copyMarkdown(file, fileContents, expanded, picked, diff);
    window.moire.copy(text).then(
      () => notify(`Copied ${count} ${count === 1 ? "line" : "lines"}${format === "markdown" ? " for an agent" : ""}`),
      (e) => notify(message(e)),
    );
  };
  const copyRef = useRef(copy);
  copyRef.current = copy;
  const onCopy = useCallback((format: "code" | "markdown", hunk: number) => copyRef.current(format, hunk), []);
  const onCopyLines = useCallback(() => copyRef.current("code"), []);
  const pickHunk = useCallback(
    (hunk: number) => {
      if (!file) return;
      const { side, keys } = hunkChange(file, hunk);
      pick(keys, shownLayout === "split" ? side : "u", true);
    },
    [file, shownLayout, pick],
  );

  const undoEntry = useCallback(
    async (only?: string) => {
      if (!repo) return;
      const root = repo.root;
      const from = activeRef.current;
      startActing();
      try {
        const result = await window.moire.undo(root, only);
        if (!result) notify("Nothing to undo");
        else if ("label" in result) {
          notify(`Undid: ${result.label}`);
          setStubs((cur) => cur.filter((stub) => stub.undoId !== result.id));
          const spot = undoSpots.current.get(result.id);
          if (spot?.to === mode.kind) arrive.current = { ...spot, onOldSide: false, note: false, undone: true, from };
        } else {
          const save = () => {
            startActing();
            window.moire
              .saveDiscarded(root, result.id)
              .then(notify, (e) => notify(message(e)))
              .finally(settle);
          };
          const dismiss = () => {
            setToast(null);
            window.moire.dropDiscarded(root, result.id).catch((e) => notify(message(e)));
          };
          setToast({
            text: result.refused,
            undo: false,
            choices: [
              { label: `Save as ${result.saveAs}`, pick: save },
              { label: "Throw away backup", pick: dismiss },
            ],
          });
        }
      } catch (e) {
        setStubs(outdated);
        notify(message(e));
      }
      settle();
    },
    [repo, mode.kind, notify, startActing, settle],
  );
  const undo = useCallback(() => void undoEntry(), [undoEntry]);

  const notesHelp = () =>
    notify(
      notesFor === "working"
        ? `No agent notes yet. An agent writes them to ${notesFile?.path ?? ".git/moire/notes.json"}`
        : `No agent notes for this ${mode.kind === "commit" ? "commit" : "comparison"}`,
    );
  const toggleNotes = () => {
    if (!agentNotes) return notesHelp();
    if (!notesFit) return notify("No room for notes at this width. Widen the window or narrow the sidebar.");
    setBriefShown(false);
    if (!walkRoom) setNotesAnyway(!notesOpen);
    setNotesPref(notesOpen ? "off" : "on");
  };
  const rangeAt = (index: number) => {
    const stop = stops[index];
    return stop && agentNotes?.chapters[stop.chapter].ranges[stop.range];
  };
  const isStanding = (index: number) => {
    const stop = stops[index];
    return !!stop && !!notesFile?.standing?.[stop.chapter]?.includes(stop.range);
  };
  const shownPaths = useMemo(() => new Set(files.map((f) => f.path)), [files]);
  const otherTab = mode.kind === "unstaged" ? "staged" : mode.kind === "staged" ? "unstaged" : null;
  const goToStop = (index: number) => {
    const range = rangeAt(index);
    if (!range) return;
    setStopAt(index);
    setBriefShown(false);
    setCaptionOff(false);
    // Left behind, it would take the walk's s and x to lines off screen.
    clear();
    if (currentStop === null) setNotesPref("on");
    const away = filesView !== "all" && !shownPaths.has(range.path);
    if (away && isStanding(index)) {
      pendingNote.current = index;
      setNoteTick((t) => t + 1);
      notify(`${range.path} didn't change, so this is the file as it stands`);
      return openLink(range.path);
    }
    if (away && !otherTab) return notify(`${range.path} has no changes in this view`);
    pendingNote.current = index;
    setNoteTick((t) => t + 1);
    if (away) setMode({ kind: otherTab! }, { path: range.path, newSideLine: null, note: true });
    else if (range.path !== active) setActive(range.path);
  };
  const pendingLine = useRef<{ path: string; line: number } | null>(null);
  const openUncovered = (path: string) => {
    setBriefShown(false);
    setCaptionOff(true);
    setActive(path);
    const target = files.find((f) => f.path === path);
    const line = target && agentNotes ? firstUncovered(target, agentNotes, notesFile?.placed) : null;
    pendingLine.current = line === null ? null : { path, line };
    setNoteTick((t) => t + 1);
  };
  useEffect(() => {
    const at = pendingLine.current;
    if (!at || file?.path !== at.path) return;
    const index = rowOfLine(rows, at.line);
    if (index < 0) {
      const keys = lineKeys(rows, file.hunks, at.line);
      if (keys.length && !keys.every((key) => expanded.has(key))) return setExpanded((cur) => new Set([...cur, ...keys]));
      pendingLine.current = null;
      return;
    }
    pendingLine.current = null;
    const row = rows[index];
    if ("hunk" in row && row.hunk >= 0) setFocusHunk(row.hunk);
    requestAnimationFrame(() => viewRef.current?.scrollToRow(preview ? index : rowToShow(rows, index), "start"));
  }, [rows, file, noteTick]);
  const walkEnd = useRef<number | null>(null);
  const handOff = useRef("");
  const skimsOpened = useRef(new Set<number>());
  useEffect(() => {
    skimsOpened.current.clear();
  }, [walkKey]);
  const dropHandOff = () => {
    const text = handOff.current;
    handOff.current = "";
    if (!text) return;
    setToast((cur) => {
      if (!cur?.text.endsWith(text)) return cur;
      const rest = cur.text.slice(0, -text.length).trim();
      return rest ? { ...cur, text: rest } : null;
    });
  };
  const moveStep = (delta: 1 | -1, say = notify, leavingChapter = false, byPlace = false) => {
    if (!agentNotes) return notesHelp();
    if (briefEnded && delta < 0 && currentStop !== null) return goToStop(currentStop);
    const openChapter = currentStop === null ? null : stops[currentStop].chapter;
    const notHere = (i: number) => filesView !== "all" && !shownPaths.has(rangeAt(i)!.path) && !isStanding(i);
    // Past the last read chapter, a skim chapter leads to the next one left, not back through what's been read.
    const finishing = delta > 0 && openChapter !== null && skimsOpened.current.has(openChapter);
    const passed = (s: Stop) => (s.chapter === openChapter ? leavingChapter : finishing || skims[s.chapter] !== null);
    const next = (byPlace ? nextStop : nextStep)(stops, currentStop, delta, (s, i) => notHere(i) || passed(s));
    // A change that's all skim chapters still has something to walk, and all of it can sit in the other tab.
    const fallback = currentStop === null ? (nextStop(stops, null, delta, (_, i) => notHere(i)) ?? nextStop(stops, null, delta, () => false)) : null;
    if ((next ?? fallback) !== null) {
      dropHandOff();
      return goToStop((next ?? fallback)!);
    }
    if (delta < 0) return say("That was the first step");
    const waiting = (skim: Skim | null, c: number) => skim !== null && !doneChapters.has(c) && c !== openChapter && !skimsOpened.current.has(c);
    const left = skims.flatMap((skim, c) => (waiting(skim, c) ? [c] : []));
    if (left.length && (finishing || walkEnd.current === currentStop)) {
      dropHandOff();
      skimsOpened.current.add(left[0]);
      return goToStop(firstStopLeft(agentNotes, stops, left[0], stagedStops, shownPaths));
    }
    walkEnd.current = currentStop;
    if (left.length) {
      handOff.current = `That was the last chapter to read. ${left.length} left to skim: ${k("nextNote")} opens the first.`;
      return say(handOff.current);
    }
    setBriefEnded(true);
    setBriefShown(true);
  };
  const openPath = file?.path;
  const { targets: chapterTargets, lost: lostChapters } = useMemo(() => {
    const chapters = agentNotes?.chapters ?? [];
    const out = chapters.map((): ChapterTarget[] => []);
    const bordering = new Set<number>();
    const lost = new Set<number>();
    const byPath = new Map<string, { r: NoteRange; c: number; i: number }[]>();
    chapters.forEach((ch, c) => ch.ranges.forEach((r, i) => byPath.set(r.path, [...(byPath.get(r.path) ?? []), { r, c, i }])));
    const found = (p: Placement): p is Placed | "all" => p !== "lost";
    for (const f of files) {
      const ranges = byPath.get(f.path);
      if (!ranges) continue;
      const inFile = chapters.map((): Placement[] => []);
      for (const { r, c, i } of ranges) inFile[c].push(placeAgainstShownOrWorktree(r, f.path === openPath ? bLines : null, notesFile?.placed?.[c]?.[i]));
      const all = inFile.flat().filter(found);
      inFile.forEach((mine, c) => {
        if (!mine.length) return;
        if (f.hunks.length && mine.includes("lost")) lost.add(c);
        if (mine.includes("all")) return void out[c].push({ file: f, lines: null });
        const lines = chapterRefs(f, mine.filter(found), all);
        if (lines.length) out[c].push({ file: f, lines });
        else if (!f.hunks.length) out[c].push({ file: f, lines: null });
        else if (mine.filter(found).some((at) => bordersDeletion(f, at, all))) bordering.add(c);
      });
    }
    bordering.forEach((c) => !out[c].length && lost.add(c));
    return { targets: out, lost };
  }, [agentNotes, notesFile, files, openPath, bLines]);
  const whitespaceFiles = useMemo(() => {
    const out = new Map<string, FileDiff>();
    chapterTargets.forEach((targets, c) => {
      if (!lostChapters.has(c) && whitespaceOnly(targets)) targets.forEach((t) => out.set(fileKeyOf(modeKey, t.file), t.file));
    });
    return out;
  }, [chapterTargets, lostChapters, modeKey]);
  const [plainFiles, setPlainFiles] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const wanted = [...whitespaceFiles];
    if (!repo || !wanted.length) return;
    let stale = false;
    window.moire
      .manyContents(
        repo.root,
        mode,
        wanted.map(([, f]) => f),
      )
      .then(
        (all) => {
          if (!stale) setPlainFiles(new Set(wanted.filter((_, i) => !holdsMultilineText(all[i])).map(([key]) => key)));
        },
        () => {},
      );
    return () => {
      stale = true;
    };
  }, [[...whitespaceFiles.keys()].join("\n")]);
  const skims = useMemo(
    () =>
      (agentNotes?.chapters ?? []).map((c, i) => skimOf(c, lostChapters.has(i) ? [] : (chapterTargets[i] ?? []), (f) => plainFiles.has(fileKeyOf(modeKey, f)))),
    [agentNotes, chapterTargets, lostChapters, plainFiles, modeKey],
  );
  const chapterSizes = useMemo(() => chapterTargets.map(chapterSize), [chapterTargets]);
  const invisibles = useMemo(() => (file ? hiddenLines(file) : []), [file]);
  const invisibleKey = `${repo?.root}:${file?.path}:${invisibles.map((l) => l.text).join("\n")}`;
  const againstWorktree = mode.kind === "unstaged" || mode.kind === "all";
  const doneChapters = useMemo(
    () =>
      new Set(
        againstWorktree && !ignoreWhitespace
          ? chapterTargets.flatMap((targets, c) => (targets.length || lostChapters.has(c) || notesFile?.standing?.[c]?.length ? [] : [c]))
          : [],
      ),
    [againstWorktree, ignoreWhitespace, chapterTargets, lostChapters, notesFile],
  );
  const missingCountsAsFullyStaged = mode.kind === "unstaged" && !ignoreWhitespace;
  const stagedStops = useMemo(() => {
    const out = new Map<number, "full" | "partial">();
    if (!agentNotes || (mode.kind !== "unstaged" && mode.kind !== "all")) return out;
    stops.forEach(({ chapter: c, range: i }, stop) => {
      const r = agentNotes.chapters[c].ranges[i];
      const f = files.find((f) => f.path === r.path);
      if (!f) return missingCountsAsFullyStaged && !isStanding(stop) && out.set(stop, "full");
      const at = placeAgainstShownOrWorktree(r, f.path === openPath ? bLines : null, notesFile?.placed?.[c]?.[i]);
      const staged = at === "lost" ? null : rangeStaged(f, at, mode.kind);
      if (staged) out.set(stop, staged);
    });
    return out;
  }, [mode.kind, missingCountsAsFullyStaged, stops, agentNotes, notesFile, files, openPath, bLines]);
  const stagedChapters = useMemo(() => {
    const out = new Map<number, "full" | "partial">();
    if (missingCountsAsFullyStaged) doneChapters.forEach((c) => out.set(c, "full"));
    if (mode.kind === "unstaged") stagedStops.forEach((_, s) => out.has(stops[s].chapter) || out.set(stops[s].chapter, "partial"));
    if (mode.kind !== "all") return out;
    chapterTargets.forEach((targets, c) => {
      const lines = targets.flatMap(({ file: f, lines }) =>
        (lines ?? f.hunks.flatMap((h, hunk) => h.lines.map((_, line) => ({ hunk, line })))).map((r) => f.hunks[r.hunk].lines[r.line]),
      );
      const changed = lines.filter((l) => l.kind !== "ctx");
      const staged = changed.filter((l) => l.staged).length;
      if (staged) out.set(c, staged === changed.length ? "full" : "partial");
    });
    return out;
  }, [mode.kind, missingCountsAsFullyStaged, doneChapters, stagedStops, stops, chapterTargets]);
  const notCovered = useMemo(() => (agentNotes ? uncovered(files, agentNotes, notesFile?.placed) : []), [agentNotes, notesFile, files]);
  const caption =
    !captionOff && agentNotes && currentStop !== null && rangeAt(currentStop)?.path === (want ?? file)?.path ? captionOf(agentNotes, stops, currentStop) : null;
  const stepStaged = !!caption && [...Array(caption.sameFile).keys()].every((i) => stagedStops.get(leadOf(stops, currentStop!) + i) === "full");
  const hiddenHunks =
    readingMarkdown && file!.hunks.length > 1 && !selection.size
      ? `Read doesn't mark hunks, so ${k("previewView")} switches to a view that does, or stage the whole file`
      : null;
  useEffect(() => {
    if (!briefOpen) setBriefEnded(false);
  }, [briefOpen]);
  const briefComing = useRef(false);
  const briefKey =
    repo && agentNotes && (agentNotes.asked || agentNotes.decisions)
      ? [repo.root, agentNotes.asked, agentNotes.summary, ...(agentNotes.decisions ?? [])].join("\n")
      : null;
  useEffect(() => {
    const walking = currentStop !== null || (walkKey !== null && savedStop(walkKey) !== null);
    if (briefKey && firstTime("briefs-seen", briefKey) && !walking && !selection.size) {
      briefComing.current = !briefShown;
      setBriefShown(true);
    }
  }, [briefKey]);
  // Everything staged leaves Unstaged empty, and the brief has nothing to size or walk there.
  const leftStaged = useRef(false);
  useEffect(() => {
    if (!briefOpen) leftStaged.current = false;
    const lines = diff?.progress?.lines;
    if (!briefOpen || leftStaged.current || currentStop !== null || mode.kind !== "unstaged" || files.length || !lines?.total || lines.staged < lines.total)
      return;
    leftStaged.current = true;
    setMode({ kind: "staged" });
  }, [briefOpen, diff, currentStop, mode.kind, files.length]);
  const openFile = useCallback((path: string) => {
    setBriefShown(false);
    setActive(path);
  }, []);
  const openLink = useCallback(
    (path: string) => {
      if (listed.some((f) => f.path === path)) return openFile(path);
      if (!repo) return;
      window.moire.fileContents(repo.root, mode, { path, status: "unchanged" }).then(
        (data) => {
          if (data.a === null && data.b === null && !data.binary) return notify(`${path} isn't in this repository`);
          showFiles("all");
          openFile(path);
        },
        () => notify(`${path} isn't in this repository`),
      );
    },
    [listed, openFile, repo, mode, showFiles],
  );
  const stageChapter = async (chapter: number) => {
    if (!repo || actions !== "unstaged" || acting.current) return;
    const targets = chapterTargets[chapter] ?? [];
    const moved = lostChapters.has(chapter);
    if (!targets.length)
      return notify(moved ? "This chapter's lines have changed since it was written, so stage them by hand" : "Nothing left to stage in this chapter");
    startActing();
    try {
      const n = targets.length;
      const label = `Staged chapter ${chapter + 1} in ${n} ${n === 1 ? "file" : "files"}`;
      const reqs = targets.map((t) => ({ mode: "unstaged" as const, action: "stage" as const, file: t.file, lines: t.lines }));
      await window.moire.actGroup(repo.root, reqs, label);
      setStubs(outdated);
      const rest = moved ? ". Some of its lines have changed since it was written, so they weren't staged" : "";
      notify(`${label}${rest}`, true);
      advanceFrom.current = currentStop !== null && stops[currentStop].chapter === chapter ? chapter : null;
    } catch (e) {
      notify(message(e));
    }
    clear();
    settle();
  };
  const advanceFrom = useRef<number | null>(null);
  useEffect(() => {
    const from = advanceFrom.current;
    if (from === null || busy) return;
    advanceFrom.current = null;
    const next = stops.findIndex((s, i) => s.chapter > from && !doneChapters.has(s.chapter) && !skims[s.chapter] && shownPaths.has(rangeAt(i)!.path));
    if (next >= 0) goToStop(next);
    else moveStep(1, addToToast, true);
  }, [busy]);

  useEffect(() => {
    const from = stopStagedFrom.current;
    if (from === null || busy || queued.current.length) return;
    stopStagedFrom.current = null;
    if (stagedStops.get(from) !== "full") return;
    const here = stops[from].chapter;
    const next = stops.findIndex(
      (s, i) => i > from && (s.chapter === here || !skims[s.chapter]) && stagedStops.get(i) !== "full" && shownPaths.has(rangeAt(i)!.path),
    );
    if (next >= 0) goToStop(next);
    else moveStep(1, addToToast, true);
  }, [busy]);

  const selectFile = useCallback(
    (delta: number, focus: "first" | "last" | null = null) => {
      const index = listed.findIndex((f) => f.path === active);
      const next = listed[index + delta];
      if (!next) return false;
      pendingFocus.current = focus;
      setActive(next.path);
      return true;
    },
    [listed, active],
  );

  const jumpHunk = (to: number) => {
    if (!hunkRows.length) return;
    const index = to < 0 ? hunkRows.length - 1 : to;
    setFocusHunk(index);
    viewRef.current?.scrollToRow(hunkRows[index]);
  };

  const extendSelection = (delta: number) => {
    const key = extend(delta);
    if (!key) return notify(`Click a line number first, then ${k("extendDown")} and ${k("extendUp")} extend the selection`);
    const hunk = hunkOfKey(key);
    if (hunk !== null) setFocusHunk(hunk);
    const index = rows.findIndex((r) => (r.t === "split" ? r.a?.sel === key || r.b?.sel === key : r.t === "uni" && r.line.sel === key));
    if (index >= 0) viewRef.current?.scrollToRow(index, "auto");
  };

  const moveHunk = useCallback(
    (delta: number) => {
      // A step between hunks has the next one down in focus, so only going up has to leave it.
      const leaves = !offHunk || (belowHunks.current ? delta > 0 : delta < 0);
      const next = leaves ? focusHunk + delta : focusHunk;
      if (next >= 0 && next < hunkRows.length) {
        setFocusHunk(next);
        viewRef.current?.scrollToRow(hunkRows[next]);
      } else {
        selectFile(delta, delta > 0 ? "first" : "last");
      }
    },
    [focusHunk, offHunk, hunkRows, selectFile],
  );

  const switchRepo = useCallback(
    (info: RepoInfo | null) => {
      if (!info) return;
      setSpecial(null);
      setLastPicked({});
      reset();
      setFilters({ changed: "", all: "" });
      setActive(null);
      setCommitted(null);
      setNotesFile(null);
      setStopAt(null);
      setBriefShown(false);
      setStayInAll(false);
      setRepo(info);
    },
    [reset],
  );
  const pickRepo = useCallback(() => {
    setRepoPicker(false);
    window.moire.pickRepo(repo?.root).then(switchRepo, (e) => setError(message(e)));
  }, [repo, switchRepo]);
  const openRecent = useCallback(
    (path: string) => {
      setRepoPicker(false);
      window.moire.openRepo(path).then(switchRepo, (e) => notify(message(e)));
    },
    [switchRepo, notify],
  );

  const commitStaged = async () => {
    if (!repo || !draft.trim() || acting.current) return;
    startActing();
    setCommitError(null);
    try {
      const done = await window.moire.commit(repo.root, draft.trim());
      notify(`Committed ${done}`);
      setCommitted(done);
      setDraft("");
      commitInput.current?.blur();
    } catch (e) {
      setCommitError({ root: repo.root, text: message(e) });
    }
    settle();
  };
  const shownCommitError = commitError && commitError.root === repo?.root ? commitError.text : null;

  const commitNow = () => {
    focusCommit.current = true;
    setMode({ kind: "staged" });
  };
  useEffect(() => {
    if (mode.kind !== "staged" || !focusCommit.current || !commitInput.current) return;
    focusCommit.current = false;
    commitInput.current.focus();
  });

  const layoutShown = useRef(false);
  useEffect(() => {
    // Notes arrive a render before the brief replaces the diff, and that render isn't a layout anyone sees.
    if (autoUnified && layoutShown.current && !briefComing.current && !preview)
      notify(`Unified layout while the window is narrow. Press ${k("layout")} for split anyway.`);
    layoutShown.current = true;
  }, [autoUnified]);
  useEffect(() => {
    briefComing.current = false;
  }, [briefOpen]);

  const openAt = async (root: string, path: string, line: number) => {
    const editor = await window.moire.openInEditor(root, path, line);
    if (editor) notify(`Opened in ${editor}`);
    else setEditorPicker({ path, line });
  };
  const openEditor = () => {
    if (!repo || !file) return;
    if (file.status === "deleted") return notify(`${file.path.split("/").pop()} was deleted, so there's nothing to open`);
    openAt(repo.root, file.path, editorLine(file, rows, selection, focusHunk)).catch((e) => notify(message(e)));
  };
  const closeEditorPicker = useCallback(() => setEditorPicker(null), []);
  const chooseEditor = (template: string) => {
    const pending = editorPicker;
    setEditorPicker(null);
    window.moire
      .chooseEditor(template)
      .then((name) => (repo && pending?.path ? openAt(repo.root, pending.path, pending.line) : notify(`Files will open in ${name}`)))
      .catch((e) => notify(message(e)));
  };
  const openMenu = (path: string, event: React.MouseEvent) => {
    event.preventDefault();
    setMenu({ path, x: event.clientX, y: event.clientY, file: files.find((f) => f.path === path) });
  };
  const openLineMenu = (row: LineRow, side: "a" | "b" | null, event: React.MouseEvent) => {
    if (!file) return;
    event.preventDefault();
    if (row.hunk >= 0) setFocusHunk(row.hunk);
    const onPicked = isPicked(row, side, selection, selCol);
    if (!onPicked) clear();
    const picked = onPicked ? selection : new Set<string>();
    const canAct = changedRefs(file, picked).length > 0 || (row.hunk >= 0 && !picked.size);
    const lines = canAct ? refsFor(onPicked && wholeSide ? "file" : null, picked, row.hunk) : null;
    const line = {
      no: file.status === "deleted" ? null : newSideLine(file, row),
      inHunk: row.hunk >= 0,
      text: viewRef.current?.selectedText?.() ?? "",
      picked: picked.size,
      scope: !canAct ? null : !lines ? ("file" as const) : picked.size ? lines.length : ("hunk" as const),
      file,
      lines,
    };
    setMenu({ path: file.path, x: event.clientX, y: event.clientY, line });
  };
  const actOnFile = async (action: "stage" | "unstage" | "discard", target: FileDiff) => {
    if (!repo || !actions || acting.current) return;
    startActing();
    try {
      notify(await window.moire.act(repo.root, { mode: actions, action, file: target, lines: null }), true);
      setStubs(outdated);
    } catch (e) {
      notify(message(e));
    }
    clear();
    settle();
  };
  const pickMenu = (action: MenuAction) => {
    if (!repo || !menu) return;
    const path = menu.path.replace(/\/$/, "");
    const name = path.split("/").pop();
    const done = (text: string) => () => notify(text);
    const fail = (e: unknown) => notify(message(e));
    const line = file && path === file.path ? editorLine(file, rows, selection, focusHunk) : 1;
    // The menu's own copies of the diff, so main refuses them if the file has moved on since the menu opened.
    const actOnLines = async (action: StageAction) => {
      if (menu.line && !acting.current) await send(action, menu.line.file, menu.line.lines);
    };
    const run: Record<MenuAction, () => Promise<unknown>> = {
      copy: () => window.moire.copy(path).then(done(`Copied ${path}`)),
      "copy-abs": () => window.moire.copy(`${repo.root}/${path}`).then(done(`Copied ${repo.root}/${path}`)),
      "copy-contents": async () => {
        const picked = copySide(await window.moire.fileContents(repo.root, { kind: "unstaged" }, { path, status: "unchanged" }), "b");
        if (!picked) return notify(`${name} is binary, over 2 MB or not on disk, so there's no text to copy`);
        await window.moire.copy(picked.text);
        copiedFile(name, picked.count);
      },
      reveal: () => window.moire.revealFile(repo.root, path),
      editor: () => openAt(repo.root, path, line),
      open: () => window.moire.openWithDefault(repo.root, path).then(done(`Opened ${name}`)),
      "copy-here": () => filesIn.pickInto(menu.path),
      "stage-file": async () => menu.file && (await actOnFile("stage", menu.file)),
      "unstage-file": async () => menu.file && (await actOnFile("unstage", menu.file)),
      "discard-file": async () => menu.file && (await actOnFile("discard", menu.file)),
      "copy-text": () => window.moire.copy(menu.line?.text ?? "").then(done("Copied")),
      "copy-lines": async () => runCommand("copyCode"),
      "copy-markdown": async () => runCommand("copyMarkdown"),
      "stage-here": () => actOnLines(actions === "staged" ? "unstage" : "stage"),
      "discard-here": () => actOnLines("discard"),
      "editor-line": () => openAt(repo.root, path, menu.line?.no ?? line),
    };
    run[action]().catch(fail);
  };
  const editorRef = useRef(openEditor);
  editorRef.current = openEditor;

  const modeKind = useRef(mode.kind);
  modeKind.current = mode.kind;
  const setMode = useCallback(
    (m: CompareMode, land?: { path: string; newSideLine: number | null; note?: boolean }) => {
      if (m.kind === "unstaged" || m.kind === "staged" || m.kind === "all") {
        const path = land?.path ?? activeRef.current;
        const from = SIDES[modeKind.current];
        const to = SIDES[m.kind];
        const shared = from?.find((side) => to.includes(side));
        const hunk = shared && focused.current?.path === path ? focused.current.hunk : null;
        const at = hunk ? (from.indexOf(shared!) ? hunk.newStart : hunk.oldStart) : null;
        const onOldSide = !land && !!shared && to.indexOf(shared) === 0;
        arrive.current = path && m.kind !== modeKind.current ? { to: m.kind, path, line: land ? land.newSideLine : at, onOldSide, note: !!land?.note } : null;
        setSpecial(null);
        setSimpleMode(m.kind);
      } else {
        setSpecial(m);
        setLastPicked((p) => ({ ...p, [m.kind]: m }));
      }
    },
    [setSimpleMode],
  );

  const root = repo?.root;
  const compareRun = useRef(0);
  useEffect(() => {
    if (!root) return;
    const take = async () => {
      const args = await window.moire.takeCompare();
      if (!args) return;
      const run = ++compareRun.current;
      if (args[0] === "pr") notify(`Fetching PR #${args[1]}…`);
      try {
        const next = await window.moire.compareMode(root, args);
        if (run !== compareRun.current) return;
        setMode(next);
        if (args[0] === "pr") {
          setToast(null);
          // The refs have the same names after a re-fetch, so the mode alone wouldn't reload.
          refresh();
        }
      } catch (e) {
        if (run === compareRun.current) notify(message(e));
      }
    };
    const start = () => void take();
    start();
    const off = window.moire.onCompare(start);
    return () => {
      compareRun.current++;
      off();
    };
  }, [root, setMode, notify, refresh]);

  const chooseWhitespace = (on: boolean) => {
    setWhitespacePref(on ? "on" : "off");
    notify(on ? "Hiding whitespace changes. Staging is off until you show them." : "Showing whitespace changes");
  };

  const run: Record<CommandId, () => void> = {
    nextHunk: () => moveHunk(1),
    prevHunk: () => moveHunk(-1),
    firstHunk: () => jumpHunk(0),
    lastHunk: () => jumpHunk(-1),
    nextFile: () => selectFile(1),
    prevFile: () => selectFile(-1),
    search: openSearch,
    nextHit: () => search.step(1),
    prevHit: () => search.step(-1),
    filterFiles: () => filterInput.current?.focus(),
    allFiles: () => showFiles(filesView === "all" ? "changed" : "all"),
    nextNote: () => moveStep(1),
    prevNote: () => moveStep(-1),
    nextPlace: () => moveStep(1, notify, false, true),
    prevPlace: () => moveStep(-1, notify, false, true),
    notes: toggleNotes,
    brief: () => (agentNotes ? setBriefShown(!briefOpen) : notesHelp()),
    recentRepos: () => setRepoPicker(true),
    openRepo: pickRepo,
    stage: () =>
      hiddenHunks && actions
        ? notify(hiddenHunks)
        : actions
          ? onAct(actions === "staged" ? "unstage" : "stage", null)
          : notify(stageOff ?? `Stage from the Unstaged view (${k("unstaged")}), unstage from Staged (${k("staged")})`),
    discard: () =>
      hiddenHunks
        ? notify(hiddenHunks)
        : actions === "unstaged"
          ? onAct("discard", null)
          : notify(stageOff ?? `Discard works in the Unstaged view (${k("unstaged")})`),
    stageAll: toggleStageAll,
    stageChapter: () => {
      if (currentStop === null || !caption) return notify(`Open a chapter first: ${k("nextNote")} walks them`);
      if (actions !== "unstaged") return notify(stageOff ?? `Stage chapters from the Unstaged view (${k("unstaged")})`);
      void stageChapter(stops[currentStop].chapter);
    },
    discardFile: () => (stageOff ? notify(stageOff) : discardFile()),
    undo,
    extendDown: () => extendSelection(1),
    extendUp: () => extendSelection(-1),
    blinkHold: holdBlink,
    blink: () => {
      if (hunkRows.length) toggleBlink(focusHunk);
    },
    openEditor: () => editorRef.current(),
    chooseEditor: () => setEditorPicker({ line: 1 }),
    refresh,
    cancel: () => (blink ? setBlink(null) : selection.size ? clear() : search.open ? closeSearch() : setCaptionOff(true)),
    copyMarkdown: () => copyRef.current("markdown"),
    copyCode: () => copyRef.current("code"),
    selectAll: () => {
      if (!file || !rows.some((r) => r.t === "split" || r.t === "uni")) return;
      window.getSelection()?.removeAllRanges();
      selectAll(viewRef.current?.side?.() ?? (file.status === "deleted" ? "a" : "b"));
    },
    pasteFiles: () => void filesIn.paste(),
    compare: () => setPicker("main"),
    unstaged: () => setMode({ kind: "unstaged" }),
    staged: () => setMode({ kind: "staged" }),
    all: () => setMode({ kind: "all" }),
    commit: () => (special?.kind !== "commit" && lastPicked.commit ? setMode(lastPicked.commit) : setPicker("commit")),
    branches: () => (special?.kind !== "branches" && lastPicked.branches ? setMode(lastPicked.branches) : setPicker("branches")),
    layout: () => (preview ? notify("A preview has no layouts") : chooseLayout(shownLayout === "split" ? "unified" : "split")),
    fullFile: () => (preview ? notify("A preview always shows the whole page") : setScope(scope === "full" ? "changed" : "full")),
    ignoreWhitespace: () => chooseWhitespace(!ignoreWhitespace),
    preview: () => (previewable && !previewable.forced ? togglePreview() : notify("Only Markdown and SVG files switch between preview and diff")),
    previewView: () => {
      if (preview?.kind !== "markdown") return notify("Turn on the Markdown preview first");
      if (!hasTwoVersions(file!, preview.old)) return notify("This file has only one version, so there's nothing to compare");
      if (readOnly(file!, preview.text, preview.old)) return notify("This file is too big to compare, so it shows as plain text");
      const shown = resolveView(previewView, viewRef.current?.roomy?.() ?? true);
      setPreviewView(PREVIEW_VIEWS[(PREVIEW_VIEWS.indexOf(shown) + 1) % PREVIEW_VIEWS.length]);
    },
    theme: () => pickTheme(toneOf(theme, themes) === "dark" ? lightTheme : darkTheme),
    palette: () => setPalette((open) => !open),
    zoomIn: () => void window.moire.stepZoom(1),
    zoomOut: () => void window.moire.stepZoom(-1),
    zoomReset: () => void window.moire.stepZoom(0),
    help: () => setHelp((open) => !open),
    editKeys: () => {
      setHelp(false);
      window.moire.editKeys().catch((e) => notify(message(e)));
    },
    editThemes: () => {
      setThemeMenu(false);
      window.moire.editThemes().catch((e) => notify(message(e)));
    },
  };
  if (folder) for (const id of GIT_ONLY) run[id] = () => notify(`${repo!.name} isn't a git repository`);
  const dialog = palette ? closePalette : editorPicker ? closeEditorPicker : repoPicker ? closeRepoPicker : themeMenu ? closeThemeMenu : null;
  const perform = (id: CommandId) => (briefOpen && !BRIEF_KEEPS.includes(id) ? setBriefShown(false) : run[id]());
  const latest = useRef({ perform, repo, picker, help, dialog });
  latest.current = { perform, repo, picker, help, dialog };
  const runCommand = useCallback((id: CommandId) => {
    const { perform, repo } = latest.current;
    if (!repo && !command(id).noRepo) return;
    if (id !== "help") setHelp(false);
    perform(id);
  }, []);

  const pending = useRef<{ stroke: string; at: number } | null>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const { perform, repo, picker, help, dialog } = latest.current;
      const stroke = strokeOf(event, MAC);
      if (!stroke) return;
      const prev = pending.current && event.timeStamp - pending.current.at < SEQUENCE_MS ? pending.current.stroke : null;
      pending.current = null;
      const inField = event.target instanceof HTMLElement && !!event.target.closest("input:not([type=checkbox]), select, textarea, .file-menu");
      const id = lookup(keymapRef.current, prev, stroke);
      if (dialog && id !== "palette") {
        if (stroke === "Escape") dialog();
        return;
      }
      if (id === "prefix") {
        if (!inField && !picker && !help && repo) pending.current = { stroke, at: event.timeStamp };
        return;
      }
      if (!id) return;
      const cmd = command(id);
      if (inField && !(cmd.inTextFields && stroke.startsWith("Mod+"))) return;
      if (help) {
        if (id === "help") setHelp(false);
        return;
      }
      const switching = !inField && COMPARE_KEYS.has(id);
      if ((picker && !switching) || cmd.handledByMain || (!repo && !cmd.noRepo)) return;
      if (id === "copyCode" && window.getSelection()?.toString()) return;
      event.preventDefault();
      if (picker && switching) setPicker(null);
      if (!(event.repeat && cmd.noRepeat)) perform(id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    return window.moire.onMenu((id, path) => {
      if (id === "recentRepos" && path) openRecent(path);
      else runCommand(id);
    });
  }, [openRecent, runCommand]);

  useDevHooks(viewRef, !!diff && (!file || file.binary || !!file.tooLarge || (!!cachedTokens && file === want) || fileContents?.hidden === true));

  const stagedOnly = mode.kind === "unstaged" && !files.length ? (diff?.progress?.stagedFiles ?? 0) : 0;
  const [committedSha, ...committedSubject] = committed?.split(" ") ?? [];
  const justCommitted = !!committed && !files.length && diff?.repo.head === committedSha && !special;
  const emptyCopy: Pick<React.ComponentProps<typeof NoChanges>, "copy" | "actions"> = folder
    ? {
        copy: [`${repo!.name} isn't a git repository.`, "Pick a file on the left to read it. Reviewing changes needs a repository."],
        actions: (
          <button className="btn" onClick={pickRepo}>
            Open a repository
            <Key id="openRepo" />
          </button>
        ),
      }
    : ignoreWhitespace
      ? {
          copy: ["Nothing to show with whitespace hidden.", "There may still be whitespace changes here."],
          actions: (
            <button className="btn" onClick={() => chooseWhitespace(false)}>
              Show whitespace changes
              <Key id="ignoreWhitespace" />
            </button>
          ),
        }
      : allHidden
        ? { copy: ["Everything is staged.", "Turn off Hide staged to see the staged files."] }
        : stagedOnly
          ? {
              copy: [
                stagedOnly === 1 ? "Everything is staged." : `All ${stagedOnly} changes are staged.`,
                `Review ${stagedOnly === 1 ? "it" : "them"} in the Staged view, then commit.`,
              ],
              actions: (
                <>
                  <button className="btn" onClick={() => setMode({ kind: "staged" })}>
                    Review staged
                    <Key id="staged" />
                  </button>
                  <button className="btn" onClick={commitNow}>
                    Commit
                  </button>
                </>
              ),
            }
          : justCommitted
            ? {
                copy: [
                  "Committed.",
                  <>
                    <code>{committedSha}</code> {committedSubject.join(" ")}
                  </>,
                ],
                actions: (
                  <button className="btn" onClick={() => setMode({ kind: "commit", sha: committedSha })}>
                    Show commit
                  </button>
                ),
              }
            : mode.kind === "staged"
              ? {
                  copy: [
                    "Nothing staged.",
                    `Stage hunks in Unstaged with ${k("stage") || "the Stage button"} as you review them. They wait here for the commit.`,
                  ],
                  actions: (
                    <>
                      <button className="btn" onClick={() => setMode({ kind: "unstaged" })}>
                        Review unstaged
                        <Key id="unstaged" />
                      </button>
                      <button className="btn" onClick={() => showFiles("all")}>
                        All files
                        <Key id="allFiles" />
                      </button>
                    </>
                  ),
                }
              : {};

  const toolbar = (
    <Toolbar
      root={repo?.root ?? null}
      folder={folder}
      mode={mode}
      a={diff?.a}
      b={diff?.b}
      layout={shownLayout}
      autoLayout={autoUnified}
      previewing={!!preview}
      scope={scope}
      theme={theme}
      themes={themes}
      themeProblems={themeProblems}
      onEditThemes={() => runCommand("editThemes")}
      themeWarnings={themeWarnings}
      themeMenu={themeMenu}
      onThemeMenu={setThemeMenu}
      cvd={cvd === "on"}
      followSystem={followSystem === "on"}
      picker={picker}
      lastPicked={lastPicked}
      onPicker={setPicker}
      onMode={setMode}
      onLayout={(next) => {
        setBriefShown(false);
        chooseLayout(next);
      }}
      onScope={(next) => {
        setBriefShown(false);
        setScope(next);
      }}
      onTheme={pickTheme}
      onCvd={(on) => setCvd(on ? "on" : "off")}
      onFollowSystem={(on) => setFollowSystem(on ? "on" : "off")}
      codeFont={codeFont}
      codeSize={codeSize}
      onCodeFont={setCodeFont}
      onCodeSize={setCodeSize}
      ignoreWhitespace={ignoreWhitespace}
      onIgnoreWhitespace={chooseWhitespace}
      onSearch={openSearch}
      notes={agentNotes ? { open: notesOpen } : null}
      onNotes={toggleNotes}
    />
  );
  const commandPalette = palette && (
    <CommandPalette available={(id) => (repo ? !(folder && GIT_ONLY.includes(id)) : command(id).noRepo === true)} onRun={runCommand} onClose={closePalette} />
  );
  const keysHelp = help && (
    <KeysHelp hints={hints === "on"} onHints={(on) => setHints(on ? "on" : "off")} onClose={closeHelp} onEdit={() => runCommand("editKeys")} />
  );

  if (!repo) {
    return (
      <div className="app no-repo">
        {toolbar}
        {booting ? <div className="loading" /> : <NoRepo error={error} onPick={pickRepo} />}
        <StatusBar loadedAt={null} files={[]} error={null} actions={null} zoom={zoom} hints={false} onCommand={runCommand} />
        <Toast toast={toast} onUndo={undo} />
        <HoverTip />
        {repoPicker && <RepoPicker current={null} onOpen={openRecent} onBrowse={pickRepo} onClose={closeRepoPicker} />}
        {keysHelp}
        {commandPalette}
      </div>
    );
  }

  return (
    <div className={`app${notesOpen ? " has-notes" : ""}${briefOpen ? " has-brief" : ""}`} aria-busy={busy}>
      {toolbar}
      {diff ? (
        <>
          {search.open && (
            <SearchBar
              ref={searchInput}
              options={search.options}
              invalid={search.invalid}
              loading={search.loading}
              total={search.total}
              index={search.index}
              onOptions={search.setOptions}
              onStep={search.step}
              onClose={closeSearch}
            />
          )}
          {mode.kind === "commit" && <CommitHead root={repo.root} sha={mode.sha} />}
          <Sidebar
            repo={diff.repo}
            upstream={upstream}
            view={filesView}
            onView={showFiles}
            files={listed}
            changed={files}
            tree={sideTree}
            refreshTick={refreshTick}
            active={active}
            hitCounts={search.counts}
            fresh={fresh}
            filter={filters[filesView]}
            filterRef={filterInput}
            onFilter={setFilter}
            onSelect={openFile}
            menu={menu?.path ?? null}
            onMenu={openMenu}
            onSwitchRepo={() => setRepoPicker(true)}
            onMode={setMode}
            reveal={folderReveal}
            width={side}
            onWidth={setSideWidth}
          >
            <DropFoot drag={filesIn.drag} clash={filesIn.clash} writable={writable} ignored={dropIgnored} onCancel={filesIn.cancel} />
            {!filesIn.drag && !filesIn.clash && diff.progress && diff.progress.lines.total > 0 && (
              <StageProgress
                staged={diff.progress.lines.staged}
                total={diff.progress.lines.total}
                files={diff.progress}
                changed={files.filter((f) => f.changedSinceStaged).length}
                hideStaged={mode.kind === "all" ? hideStaged === "on" : null}
                onHideStaged={hideStagedFiles}
                stageAll={actions === "unstaged" && files.length ? { label: allLabel("Stage"), busy, run: toggleStageAll } : null}
              />
            )}
            {!filesIn.drag && !filesIn.clash && mode.kind === "staged" && (
              <CommitBox
                inputRef={commitInput}
                message={draft}
                busy={busy}
                staged={files.length}
                blocked={ignoreWhitespace ? "Show whitespace changes to commit, so nothing goes in that you can't see" : null}
                unstageLabel={allLabel("Unstage")}
                error={shownCommitError}
                onMessage={setDraft}
                onCommit={commitStaged}
                onUnstageAll={toggleStageAll}
                onCopyError={() =>
                  window.moire.copy(shownCommitError ?? "").then(
                    () => notify("Copied the error"),
                    (e) => notify(message(e)),
                  )
                }
                onDismissError={() => setCommitError(null)}
              />
            )}
          </Sidebar>
          {briefOpen && agentNotes && (
            <Brief
              notes={agentNotes}
              stops={stops}
              sizes={chapterSizes}
              inView={chapterTargets.map((targets, c) => targets.length > 0 || lostChapters.has(c) || !!notesFile?.standing?.[c]?.length)}
              skims={skims}
              doneChapters={doneChapters}
              root={repo.root}
              files={files}
              uncovered={notCovered}
              commits={notesFile?.commits}
              view={mode.kind}
              started={currentStop !== null}
              ended={briefEnded}
              onStart={() => moveStep(1)}
              onBack={() => moveStep(-1)}
              onView={runCommand}
              onUncovered={openUncovered}
              onStop={goToStop}
              onChapter={(c) => goToStop(firstStopLeft(agentNotes, stops, c, stagedStops, shownPaths))}
              onClose={() => setBriefShown(false)}
            />
          )}
          {!briefOpen && !file && !filesIn.clash && (!files.length || allHidden) && (
            <NoChanges mode={mode} {...emptyCopy} onBranches={() => setPicker("branches")} onAllFiles={() => showFiles("all")} />
          )}
          {!briefOpen && filesIn.clash && (
            <>
              <ClashBar clash={filesIn.clash} onDecide={filesIn.decide} onCancel={filesIn.cancel} />
              <ClashView key={filesIn.clash.clashes[filesIn.clash.at].dest} clash={filesIn.clash} layout={shownLayout} scope={scope} />
            </>
          )}
          {!briefOpen && file && !filesIn.clash && (
            <DiffView
              key={`${modeKey}:${file.path}`}
              ref={viewRef}
              file={file}
              rows={rows}
              initialRow={
                revealRow >= 0
                  ? { index: revealRow, align: "center" }
                  : pendingFocus.current && hunkRows.length
                    ? { index: hunkRows[pendingFocus.current === "first" ? 0 : hunkRows.length - 1], align: "start" }
                    : undefined
              }
              spot={pendingNote.current === null ? spots.current.get(spotKey)?.at : undefined}
              onSpot={(at) => remember(spots.current, spotKey, { hunk: file.hunks[focusHunk], at })}
              layout={shownLayout}
              a={diff.a}
              b={diff.b}
              tokens={fileTokens}
              focusHunk={offHunk ? -1 : focusHunk}
              selection={selection}
              selCol={selCol}
              wholeHunks={wholeHunks}
              selLines={wholeSide ? (sideLines[wholeSide] ?? selection.size) : selection.size}
              sideLines={sideLines}
              hits={search.inFile}
              currentHit={search.current}
              find={search.find}
              actions={file.status === "unchanged" ? null : actions}
              onExpand={(key) => setExpanded((cur) => new Set(cur).add(key))}
              onFocusHunk={setFocusHunk}
              onSelect={selectLine}
              onAct={onAct}
              onCopy={onCopy}
              onCopyLines={onCopyLines}
              onCopySide={onCopySide}
              onPickHunk={pickHunk}
              onTextSelect={clear}
              onDiscardFile={discardFile}
              preview={preview}
              onTogglePreview={previewable && !previewable.forced ? togglePreview : null}
              onPreviewView={setPreviewView}
              onOpenLink={openLink}
              blink={blink}
              onBlink={toggleBlink}
              onMenu={openMenu}
              onLineMenu={openLineMenu}
              onStub={(action, line) =>
                action === "undo"
                  ? void undoEntry(stubs.findLast((s) => s.treeLine === line && s.undoable)?.undoId ?? "")
                  : setMode({ kind: "staged" }, { path: file.path, newSideLine: stubs.find((s) => s.treeLine === line)?.indexLine ?? null })
              }
              notice={
                <div className="notices">
                  {caption && (
                    <StepCaption
                      {...caption}
                      staged={stepStaged}
                      skim={skims[caption.chapter - 1]}
                      onStep={(delta) => moveStep(delta)}
                      onPlace={(delta) => moveStep(delta, notify, false, true)}
                      onSkip={() => moveStep(1, notify, true)}
                      onStage={actions === "unstaged" ? () => void stageChapter(caption.chapter - 1) : null}
                    />
                  )}
                  {file.changedSinceStaged && !readingMarkdown && !quietNotices.has(`${repo.root}:${file.path}`) && (
                    <StagedNotice
                      newEdits={diff.a.kind === "index"}
                      preview={!!preview}
                      onMode={setMode}
                      onClose={() => setQuietNotices((cur) => new Set(cur).add(`${repo.root}:${file.path}`))}
                    />
                  )}
                  {!preview && undecoded && <EncodingNotice staging={!!actions && file.status !== "unchanged"} />}
                  {invisibles.length > 0 && !quietNotices.has(invisibleKey) && (
                    <InvisibleNotice lines={invisibles} onClose={() => setQuietNotices((cur) => new Set(cur).add(invisibleKey))} />
                  )}
                </div>
              }
              notes={
                (notesOpen || caption) && fileMarks
                  ? {
                      marks: fileMarks,
                      chapter: currentStop === null ? null : stops[currentStop].chapter,
                      stop: currentStop === null ? null : leadOf(stops, currentStop),
                    }
                  : null
              }
              onRevealFolder={revealFolder}
            />
          )}
          {notesOpen && agentNotes && (
            <NotesPanel
              width={shownNotesWidth}
              onWidth={setNotesWidth}
              root={repo.root}
              notes={agentNotes}
              stops={stops}
              stop={currentStop}
              shownPaths={shownPaths}
              otherTab={otherTab && (otherTab === "staged" ? "Staged" : "Unstaged")}
              doneChapters={doneChapters}
              staged={stagedChapters}
              stagedStops={stagedStops}
              skims={skims}
              uncovered={notCovered}
              commits={notesFile?.commits}
              onStop={goToStop}
              onStage={actions === "unstaged" ? (c) => void stageChapter(c) : null}
              onUncovered={openUncovered}
              onStep={(delta) => moveStep(delta)}
              onBrief={() => setBriefShown(true)}
              onClose={() => setNotesPref("off")}
            />
          )}
        </>
      ) : (
        <div className="loading" />
      )}
      <DropSlots drag={filesIn.drag} slots={filesIn.slots} writable={writable} />
      <DropStyle drag={filesIn.drag} clash={filesIn.clash} ignored={dropIgnored} />
      <StatusBar
        loadedAt={loadedAt}
        files={files}
        error={error}
        actions={actions}
        zoom={zoom}
        folder={folder}
        notes={!!agentNotes}
        walking={currentStop !== null}
        brief={briefOpen}
        ended={briefOpen && briefEnded}
        onCommand={runCommand}
      />
      <Toast toast={toast} onUndo={undo} />
      <HoverTip />
      {menu && (
        <FileMenu
          at={menu}
          onDisk={files.find((f) => f.path === menu.path)?.status !== "deleted"}
          copyHere={writable}
          actions={actions}
          changed={files.some((f) => f.path === menu.path)}
          onPick={pickMenu}
          onClose={closeMenu}
        />
      )}
      {repoPicker && <RepoPicker current={repo.root} onOpen={openRecent} onBrowse={pickRepo} onClose={closeRepoPicker} />}
      {editorPicker && <EditorPicker onPick={chooseEditor} onClose={closeEditorPicker} />}
      {keysHelp}
      {commandPalette}
    </div>
  );
}

function newSideLine(file: FileDiff, row: LineRow): number {
  return Math.max(1, (row.t === "split" ? row.b?.no : row.b) ?? file.hunks[row.hunk]?.newStart ?? 1);
}

function editorLine(file: FileDiff, rows: Row[], selection: ReadonlySet<string>, focusHunk: number): number {
  for (const r of selection.size ? rows : []) {
    const picked = r.t === "split" ? [r.a, r.b].some((s) => s?.sel && selection.has(s.sel)) : r.t === "uni" && !!r.line.sel && selection.has(r.line.sel);
    if (!picked || (r.t !== "split" && r.t !== "uni")) continue;
    return newSideLine(file, r);
  }
  const hunk = file.hunks[focusHunk];
  return Math.max(1, hunk?.lines.find((l) => l.kind === "add")?.newNo ?? hunk?.newStart ?? 1);
}

function useDevHooks(viewRef: React.RefObject<DiffViewHandle | null>, settled: boolean) {
  const done = useRef(false);
  useEffect(() => {
    if (!settled || done.current) return;
    done.current = true;
    void window.moire.devHooks().then((hooks) => {
      if (hooks.bench) runBench(viewRef.current?.scroller() ?? null);
      else if (hooks.screenshot) void window.moire.ready();
    });
  }, [settled, viewRef]);
}

function runBench(el: HTMLDivElement | null) {
  if (!el) return void window.moire.benchReport("no diff to scroll");
  el.scrollTop = 0;
  const deltas: number[] = [];
  let last = 0;
  const step = (now: number) => {
    if (last) deltas.push(now - last);
    last = now;
    el.scrollTop += 40;
    if (el.scrollTop + el.clientHeight < el.scrollHeight - 1 && deltas.length < 6000) return void requestAnimationFrame(step);
    const sorted = [...deltas].sort((a, b) => a - b);
    const avg = Math.round((deltas.length / deltas.reduce((s, d) => s + d, 0)) * 1000);
    const p95 = sorted[Math.floor(sorted.length * 0.95)]?.toFixed(1);
    void window.moire.benchReport(`${avg} fps avg, p95 ${p95} ms, ${deltas.filter((d) => d > 25).length}/${deltas.length} slow frames`);
  };
  requestAnimationFrame(step);
}
