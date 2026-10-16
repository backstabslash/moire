import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { buildKeymap, command, type CommandId, lookup } from "../../shared/keymap";
import type { CompareMode, FileContents, FileDiff, Hunk, LineRef, NoteRange, NotesFile, RepoInfo, StageAction, Upstream } from "../../shared/types";
import { CommitBox } from "./components/CommitBox";
import { CommitHead } from "./components/CommitHead";
import { type Blink, DiffView, type DiffViewHandle, type Preview } from "./components/DiffView";
import { NoChanges, NoRepo } from "./components/EmptyState";
import { EncodingNotice } from "./components/EncodingNotice";
import { FileMenu, type MenuAction, type MenuAt } from "./components/FileMenu";
import { ClashBar, ClashView, DropFoot, DropSlots, DropStyle, ghostTree } from "./components/FilesIn";
import { Key, keyText, MAC, setKeymap, useKeymap } from "./components/Key";
import { KeysHelp } from "./components/KeysHelp";
import { NotesPanel } from "./components/NotesPanel";
import { RepoPicker } from "./components/RepoPicker";
import { SearchBar } from "./components/SearchBar";
import { StagedNotice, StageProgress } from "./components/StageProgress";
import { type FilesView, SIDE_WIDTH, Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { DARK_IDS, LIGHT_IDS, THEME_IDS, type ThemeId, toneOf } from "./components/ThemePicker";
import { Toast, type ToastMsg } from "./components/Toast";
import { type LastPicked, type PickerState, Toolbar } from "./components/Toolbar";
import { highlight, warm } from "./highlight/client";
import type { TokLines } from "./highlight/types";
import { fileKey as fileKeyOf, fuzzyMatch, hashString, remember } from "./model/files";
import { langFor } from "./model/lang";
import { type Grouping, orderBy } from "./model/paired";
import { previewOf } from "./model/preview";
import { buildRows, followHunk, type Layout, notUtf8, type Row, type Scope, splitLines } from "./model/rows";
import { type Placed, chapterRefs, placeRange, uncovered } from "../../shared/chapters";
import { lineKeys, type Mark, rowOfLine, stopsOf } from "./model/notes";
import { copyCode, copyMarkdown, copySide } from "./model/copy";
import { strokeOf, sameKey } from "./model/keyboard";
import { carryKeys, changedRefs, hunkChange, hunkRefs, lineKey } from "./model/selection";
import { type Hit, hitKeys, hitRow } from "./model/search";
import { useDiff } from "./useDiff";
import { isIgnored, useFilesIn } from "./useFilesIn";
import { useSearch } from "./useSearch";
import { useSelection } from "./useSelection";
import { useStored, useStoredNumber } from "./useStored";
import { useTree } from "./useTree";

type SimpleMode = "unstaged" | "staged" | "all";

const BLINK_MS = 650;
const SEQUENCE_MS = 1000;
// How long the previous file stays up while the next one loads and colours.
const HOLD_MS = 100;
// Below this many pixels for the diff, split panes wrap most lines, so split view steps aside.
const SPLIT_MIN = 1000;
const NOTES_WIDTH = 330;
const REMEMBERED_REPOS = 50;

interface Shown {
  root: string;
  file: FileDiff;
  key: string;
  contents: FileContents | null;
  tokens: [TokLines | null, TokLines | null] | null;
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
  const wantMode = useMemo<CompareMode>(() => special ?? { kind: simpleMode }, [special, simpleMode]);
  const [layout, setLayout] = useStored<Layout>("layout", "split", ["split", "unified"]);
  const [sideWidth, setSideWidth] = useStoredNumber("sidebar", SIDE_WIDTH.initial, SIDE_WIDTH.min, SIDE_WIDTH.max);
  const [winWidth, setWinWidth] = useState(innerWidth);
  const side = Math.min(sideWidth, Math.max(SIDE_WIDTH.min, Math.round(winWidth / 2)));
  const [notesFile, setNotesFile] = useState<NotesFile | null>(null);
  const [notesPref, setNotesPref] = useStored<"on" | "off">("notes", "on", ["on", "off"]);
  const [stopAt, setStopAt] = useState<number | null>(null);
  const agentNotes = notesFile?.notes?.chapters.length ? notesFile.notes : null;
  const notesOpen = !!agentNotes && notesPref === "on";
  const stops = useMemo(() => (agentNotes ? stopsOf(agentNotes) : []), [agentNotes]);
  const currentStop = stopAt !== null && stopAt < stops.length ? stopAt : null;
  const narrow = winWidth - side - (notesOpen ? NOTES_WIDTH : 0) < SPLIT_MIN;
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
  const [previewPref, setPreviewPref] = useStored<"on" | "off">("preview", "off", ["on", "off"]);
  const [theme, setTheme] = useStored<ThemeId>("theme", matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light", THEME_IDS);
  const [lightTheme, setLightTheme] = useStored<ThemeId>("theme-light", "light", LIGHT_IDS);
  const [darkTheme, setDarkTheme] = useStored<ThemeId>("theme-dark", "dark", DARK_IDS);
  const [cvd, setCvd] = useStored<"on" | "off">("cvd", "off", ["on", "off"]);
  const [hideStaged, setHideStaged] = useStored<"on" | "off">("hide-staged", "off", ["on", "off"]);
  const [blink, setBlink] = useState<(Blink & { auto: boolean }) | null>(null);
  const [zoom, setZoom] = useState(1);
  const blinkRef = useRef(blink);
  blinkRef.current = blink;
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const [focusHunk, setFocusHunk] = useState(0);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [contents, setContents] = useState<{ key: string; data: FileContents } | null>(null);
  const [tokens, setTokens] = useState<{ key: string; data: [TokLines | null, TokLines | null] } | null>(null);
  const [picker, setPicker] = useState<PickerState>(null);
  const [toast, setToast] = useState<ToastMsg | null>(null);
  const keymap = useKeymap();
  const keymapRef = useRef(keymap);
  keymapRef.current = keymap;
  const k = (id: CommandId) => keyText(keymap, id);
  const [help, setHelp] = useState(false);
  const closeHelp = useCallback(() => setHelp(false), []);
  const shownFiles = useRef<string[]>([]);
  const viewRef = useRef<DiffViewHandle>(null);
  const pendingFocus = useRef<"first" | "last" | null>(null);
  const restoreFile = useRef<string | null>(null);
  const contentCache = useRef(new Map<string, FileContents>());
  const tokenCache = useRef(new Map<string, [TokLines | null, TokLines | null]>());

  const [filesView, setFilesView] = useStored<FilesView>("files", "changed", ["changed", "all"]);
  const browsing = useRef(filesView === "all");
  browsing.current = filesView === "all";
  const [grouping, setGrouping] = useStored<Grouping>("grouping", "paired", ["paired", "folder"]);
  const hidden = useCallback((m: CompareMode, f: FileDiff) => m.kind === "all" && hideStaged === "on" && f.staged === "full", [hideStaged]);
  const visible = (m: CompareMode, files: FileDiff[]) => orderBy(grouping, files).filter((f) => !hidden(m, f));
  const { mode, diff, loadedAt, fresh, refreshTick, refresh, reset, busy, acting, startActing, settle } = useDiff(repo, wantMode, {
    async prefetch(root, m, result) {
      const open = result.files.find((f) => f.path === activeRef.current);
      const openKey = open && fileKeyOf(JSON.stringify(m), open);
      if (!open || !openKey || open.binary || open.tooLarge || contentCache.current.has(openKey)) return;
      const data = await window.moire.fileContents(root, m, open).catch(() => null);
      if (data) remember(contentCache.current, openKey, data);
    },
    loaded(result, m, sameView) {
      setError(null);
      const ordered = visible(m, result.files);
      const has = (p: string | null) => ordered.some((f) => f.path === p);
      const wanted = localStorage.getItem("moire.file") ?? restoreFile.current;
      localStorage.removeItem("moire.file");
      restoreFile.current = null;
      setActive((cur) => {
        const kept = [cur, wanted].find(has);
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
      setActive((cur) => (ordered.some((f) => f.path === cur) ? cur : (ordered[0]?.path ?? null)));
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
        ? { path: active, status: "unchanged", binary: false, blobs: hashString(JSON.stringify(browsedData)), additions: 0, deletions: 0, hunks: [] }
        : null,
    [active, browsedData],
  );
  const want = changedFile ?? browsedFile;
  const wantKey = useMemo(() => (want ? fileKeyOf(modeKey, want) : null), [want, modeKey]);
  const files = useMemo(() => orderBy(grouping, diff?.files ?? []), [diff, grouping]);
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
  // The working notes tell the story of what's uncommitted, a commit keeps its own, and branch comparisons have none.
  const notesFor = mode.kind === "commit" ? mode.sha : mode.kind === "branches" ? null : "working";
  useEffect(() => {
    setStopAt(null);
  }, [notesFor]);
  useEffect(() => {
    if (!repo) return;
    if (notesFor === null) return setNotesFile(null);
    let stale = false;
    window.moire.notes(repo.root, notesFor === "working" ? undefined : notesFor).then(
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
    const root = document.documentElement;
    root.dataset.theme = theme;
    root.dataset.tone = toneOf(theme);
    (toneOf(theme) === "dark" ? setDarkTheme : setLightTheme)(theme);
    root.dataset.cvd = cvd;
    const css = getComputedStyle(root);
    void window.moire.setTheme(css.getPropertyValue("--frame").trim(), css.getPropertyValue("--graphite").trim());
  }, [theme, cvd, setDarkTheme, setLightTheme]);

  useEffect(() => {
    document.documentElement.dataset.layout = shownLayout;
  }, [shownLayout]);

  useEffect(() => {
    document.documentElement.style.setProperty("--side", `${side}px`);
  }, [side]);

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
          if (have && have.a === data.a && have.b === data.b && have.tooLarge === data.tooLarge) return cur;
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
    if (!want || !wantKey || !wantContents || wantContents.tooLarge || tokenCache.current.has(wantKey)) return;
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
  const wantReady = want ? want.binary || !!want.tooLarge || (!!wantContents && (wantContents.tooLarge || !!wantTokens)) : !browsePending;
  const [late, setLate] = useState<string | null>(null);
  useEffect(() => {
    if (wantReady || !wantKey) return;
    const timer = setTimeout(() => setLate(wantKey), HOLD_MS);
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

  const shownView = `${modeKey}:${file?.path}`;
  const [resetFor, setResetFor] = useState(shownView);
  if (resetFor !== shownView) {
    setResetFor(shownView);
    setExpanded(new Set());
    setFocusHunk(0);
    setBlink(null);
  }

  const focused = useRef<{ path: string; hunk: Hunk } | null>(null);
  useEffect(() => {
    const prev = focused.current;
    if (!file || !prev || prev.path !== file.path || file.hunks[focusHunk] === prev.hunk || !file.hunks.length) return;
    const next = followHunk(prev.hunk, file.hunks);
    if (next === focusHunk) return;
    setFocusHunk(next);
    setBlink((b) => b && { ...b, hunk: next });
  }, [file]);
  useEffect(() => {
    const hunk = file?.hunks[focusHunk];
    focused.current = file && hunk ? { path: file.path, hunk } : null;
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
        }
      : null;
  const togglePreview = useCallback(() => setPreviewPref((p) => (p === "on" ? "off" : "on")), [setPreviewPref]);

  const blinkHunk = blink?.hunk;
  const rows = useMemo(
    () => (file ? buildRows(file, fileContents, { layout: shownLayout, scope, expanded, plates: blinkHunk }) : []),
    [file, fileContents, shownLayout, scope, expanded, blinkHunk],
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
      if (at && at !== "lost") marks.push({ ...at, chapter, stop });
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
    setFocusHunk((f) => Math.min(f, Math.max(0, hunkRows.length - 1)));
    setBlink((b) => (b && b.hunk < hunkRows.length ? b : null));
    if (!pendingFocus.current || !hunkRows.length) return;
    const target = pendingFocus.current === "first" ? 0 : hunkRows.length - 1;
    pendingFocus.current = null;
    setFocusHunk(target);
    requestAnimationFrame(() => viewRef.current?.scrollToRow(hunkRows[target]));
  }, [hunkRows]);

  const [filters, setFilters] = useState<Record<FilesView, string>>({ changed: "", all: "" });
  const setFilter = useCallback((text: string) => setFilters((cur) => ({ ...cur, [filesView]: text })), [filesView]);
  const filter = filters.changed;
  const filterInput = useRef<HTMLInputElement>(null);
  const listed = useMemo(() => files.filter((f) => (!filter || fuzzyMatch(filter, f.path)) && !hidden(mode, f)), [files, filter, hidden, mode]);
  const showFiles = useCallback(
    (view: FilesView) => {
      setFilesView(view);
      if (view === "changed" && !files.some((f) => f.path === activeRef.current)) setActive(listed[0]?.path ?? null);
    },
    [files, listed, setFilesView],
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
          return abort.signal.aborted || data.tooLarge
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
    if (!stop || !range || !file || file.path !== range.path || (range.code && !fileContents && !file.binary)) return;
    const placed = placeRange(range, bLines);
    const index = placed && placed !== "lost" ? rowOfLine(rows, placed.start) : (hunkRows[0] ?? 0);
    if (placed && placed !== "lost" && index < 0) {
      const keys = lineKeys(rows, file.hunks, placed.start);
      pendingNote.current = keys.length && !keys.every((k) => expanded.has(k)) ? at : null;
      if (pendingNote.current !== null) setExpanded((cur) => new Set([...cur, ...keys]));
      return;
    }
    pendingNote.current = null;
    if (placed === "lost") notify(`Chapter ${stop.chapter + 1}'s lines in ${range.path.split("/").pop()} changed since it was written`);
    const row = rows[index];
    if (row && "hunk" in row && row.hunk >= 0) setFocusHunk(row.hunk);
    requestAnimationFrame(() => viewRef.current?.scrollToRow(index, "start"));
  }, [rows, file, fileContents, noteTick]);

  const allHidden = files.length > 0 && files.every((f) => hidden(mode, f));
  const hideStagedFiles = (hide: boolean) => {
    setHideStaged(hide ? "on" : "off");
    if (hide && changedFile?.staged === "full") setActive(files.find((f) => f.staged !== "full")?.path ?? null);
  };
  const [repoPicker, setRepoPicker] = useState(false);
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

  const { selection, col: selCol, whole, hunks: pickedHunks, select, selectAll, pick, extend, clear, carry } = useSelection(rows);
  const [selectedIn, setSelectedIn] = useState({ key: fileKey, view: shownView, rows });
  if (selectedIn.rows !== rows) {
    if (selectedIn.key !== fileKey && !(whole && selectedIn.view === shownView))
      carry(selectedIn.view === shownView && selection.size ? carryKeys(selectedIn.rows, rows, selection) : null);
    setSelectedIn({ key: fileKey, view: shownView, rows });
  }

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
  // The search bar takes room above the diff, so the scroll moves by its height and the lines stay put.
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
    // The hit's folds open while rendering, so a hit in the open file needs a render of its own.
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

  const actions = mode.kind === "unstaged" || mode.kind === "staged" ? mode.kind : null;
  const notify = useCallback((text: string, undo = false) => setToast({ text, undo }), []);
  const writable = diff?.b.kind === "worktree";
  const filesIn = useFilesIn({ repo, writable, tree, view: filesView, onView: showFiles, open: active, notify, startActing, settle });
  const dropDir = filesIn.clash?.plan.dir ?? filesIn.drag?.target ?? null;
  const dropIgnored = dropDir !== null && isIgnored(tree, dropDir);
  const sideTree = useMemo(() => ghostTree(tree, filesIn.clash), [tree, filesIn.clash]);

  // Stage and unstage presses that land while one runs wait their turn; each acts on what's focused when it starts.
  const queued = useRef<{ action: StageAction; root: string; mode: "unstaged" | "staged" }[]>([]);
  const act = async (action: StageAction, target: number | "file" | null, press?: (typeof queued.current)[number]) => {
    if (!repo || !file || !actions) return;
    if (whole && target === null) target = "file";
    if (press && (press.root !== repo.root || press.mode !== actions)) {
      queued.current = [];
      return;
    }
    if (acting.current) {
      // The running press uses up the selection, so a queued one would widen to the whole hunk.
      if (target === null && action !== "discard" && !selection.size) queued.current.push({ action, root: repo.root, mode: actions });
      return;
    }
    if (file.status === "unchanged") return notify(`${file.path.split("/").pop()} has no changes here`);
    let lines: LineRef[] | null = null;
    const folded = file.noise && !expanded.has("noise");
    if (target !== "file" && file.hunks.length && !folded && preview?.kind !== "image") {
      const changed = changedRefs(file, selection);
      if (target === null && selection.size && !changed.length) return notify("No changed lines selected");
      const picked = changed.filter((r) => target === null || r.hunk === target);
      // A selection that stands for whole hunks only holds one side of each, and half a hunk is never what was meant.
      const widened = whole || pickedHunks ? [...new Set(picked.map((r) => r.hunk))].flatMap((h) => hunkRefs(file, h)) : picked;
      lines = widened.length ? widened : hunkRefs(file, target ?? focusHunk);
    }
    startActing();
    try {
      notify(await window.moire.act(repo.root, { mode: actions, action, file, lines }), true);
    } catch (e) {
      queued.current = [];
      notify(message(e));
    }
    clear();
    settle();
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
    if (!repo || !actions || acting.current) return;
    if (!listed.length) return notify(`Nothing to ${actions === "staged" ? "unstage" : "stage"}`);
    startActing();
    try {
      notify(await window.moire.actAll(repo.root, { mode: actions, files: listed }), true);
    } catch (e) {
      notify(message(e));
    }
    clear();
    settle();
  };
  const actAllRef = useRef(actAll);
  actAllRef.current = actAll;
  // Stages every listed file in the Unstaged view and unstages them in the Staged view, like s does for one.
  const stageAll = useCallback(() => actAllRef.current(), []);
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
    if (format === "code" && hunk === undefined && whole) return copyWhole(whole);
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

  const undo = useCallback(async () => {
    if (!repo) return;
    const root = repo.root;
    startActing();
    try {
      const result = await window.moire.undo(root);
      if (!result) notify("Nothing to undo");
      else if ("label" in result) notify(`Undid: ${result.label}`);
      else {
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
      notify(message(e));
    }
    settle();
  }, [repo, notify, startActing, settle]);

  const notesHelp = () =>
    notify(
      notesFor === "working"
        ? `No agent notes yet. An agent writes them to ${notesFile?.path ?? ".git/moire/notes.json"}`
        : `No agent notes for this ${notesFor ? "commit" : "comparison"}`,
    );
  const rangeAt = (index: number) => {
    const stop = stops[index];
    return stop && agentNotes?.chapters[stop.chapter].ranges[stop.range];
  };
  const shownPaths = useMemo(() => new Set(files.map((f) => f.path)), [files]);
  const goToStop = (index: number) => {
    const range = rangeAt(index);
    if (!range) return;
    setStopAt(index);
    setNotesPref("on");
    if (filesView !== "all" && !shownPaths.has(range.path)) return notify(`${range.path} has no changes in this view`);
    pendingNote.current = index;
    setNoteTick((t) => t + 1);
    if (range.path !== active) setActive(range.path);
  };
  // Steps over ranges in files with nothing left to review here, such as a chapter already staged.
  const stepNote = (delta: number) => {
    if (!agentNotes) return notesHelp();
    let next = currentStop === null ? (delta > 0 ? 0 : stops.length - 1) : currentStop + delta;
    while (next >= 0 && next < stops.length && filesView !== "all" && !shownPaths.has(rangeAt(next)!.path)) next += delta;
    if (next < 0 || next >= stops.length) return notify(delta > 0 ? "That was the last chapter" : "That was the first chapter");
    goToStop(next);
  };
  const chapterTargets = (chapter: number) =>
    files.flatMap((f): { file: FileDiff; lines: LineRef[] | null }[] => {
      // The open file is placed against what's shown; the rest against the work tree, as read with the notes.
      const place = (r: NoteRange, c: number, i: number) =>
        f.path === file?.path && bLines ? placeRange(r, bLines) : (notesFile?.placed?.[c]?.[i] ?? placeRange(r, null));
      const found = (p: Placed | "lost" | null): p is Placed | null => p !== "lost";
      const inFile = (c: number) => (agentNotes?.chapters[c].ranges ?? []).flatMap((r, i) => (r.path === f.path ? [place(r, c, i)] : []));
      const mine = inFile(chapter);
      if (!mine.length) return [];
      if (mine.includes(null)) return [{ file: f, lines: null }];
      const all = (agentNotes?.chapters ?? []).flatMap((_, c) => inFile(c)).filter(found);
      const lines = chapterRefs(f, mine.filter(found), all);
      return lines.length ? [{ file: f, lines }] : [];
    });
  // Only against the work tree: in the staged view or a commit, a chapter missing from the diff isn't done, just elsewhere.
  const againstWorktree = mode.kind === "unstaged" || mode.kind === "all";
  const doneChapters = useMemo(
    () => new Set(againstWorktree ? (agentNotes?.chapters.flatMap((_, c) => (chapterTargets(c).length ? [] : [c])) ?? []) : []),
    [againstWorktree, agentNotes, notesFile, files, file, bLines],
  );
  const notCovered = useMemo(() => (agentNotes ? uncovered(files, agentNotes, notesFile?.placed) : []), [agentNotes, notesFile, files]);
  const stageChapter = async (chapter: number) => {
    if (!repo || actions !== "unstaged" || acting.current) return;
    const targets = chapterTargets(chapter);
    if (!targets.length) return notify("Nothing left to stage in this chapter");
    startActing();
    try {
      for (const t of targets) await window.moire.act(repo.root, { mode: "unstaged", action: "stage", file: t.file, lines: t.lines });
      const n = targets.length;
      notify(`Staged chapter ${chapter + 1} in ${n} ${n === 1 ? "file" : "files"}${n > 1 ? `. ${k("undo")} undoes one file at a time.` : ""}`);
      advanceFrom.current = chapter;
    } catch (e) {
      notify(message(e));
    }
    clear();
    settle();
  };
  // Once the staged lines have left the diff, move on to the next chapter with changes left here.
  const advanceFrom = useRef<number | null>(null);
  useEffect(() => {
    const from = advanceFrom.current;
    if (from === null || busy) return;
    advanceFrom.current = null;
    const next = stops.findIndex((s, i) => s.chapter > from && !doneChapters.has(s.chapter) && shownPaths.has(rangeAt(i)!.path));
    if (next >= 0) goToStop(next);
    else setStopAt(null);
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
    const index = rows.findIndex((r) => (r.t === "split" ? r.a?.sel === key || r.b?.sel === key : r.t === "uni" && r.line.sel === key));
    if (index >= 0) viewRef.current?.scrollToRow(index, "auto");
  };

  const moveHunk = useCallback(
    (delta: number) => {
      const next = focusHunk + delta;
      if (next >= 0 && next < hunkRows.length) {
        setFocusHunk(next);
        viewRef.current?.scrollToRow(hunkRows[next]);
      } else {
        selectFile(delta, delta > 0 ? "first" : "last");
      }
    },
    [focusHunk, hunkRows, selectFile],
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
    if (autoUnified && layoutShown.current) notify(`Unified layout while the window is narrow. Press ${k("layout")} for split anyway.`);
    layoutShown.current = true;
  }, [autoUnified]);

  const openEditor = () => {
    if (!repo || !file) return;
    if (file.status === "deleted") return notify(`${file.path.split("/").pop()} was deleted, so there's nothing to open`);
    window.moire.openInEditor(repo.root, file.path, editorLine(file, rows, selection, focusHunk)).then(
      (editor) => notify(`Opened in ${editor}`),
      (e) => notify(message(e)),
    );
  };
  const openMenu = (path: string, event: React.MouseEvent) => {
    event.preventDefault();
    setMenu({ path, x: event.clientX, y: event.clientY });
  };
  const pickMenu = (action: MenuAction) => {
    if (!repo || !menu) return;
    const path = menu.path.replace(/\/$/, "");
    const name = path.split("/").pop();
    const done = (text: string) => () => notify(text);
    const fail = (e: unknown) => notify(message(e));
    const line = file && path === file.path ? editorLine(file, rows, selection, focusHunk) : 1;
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
      editor: () => window.moire.openInEditor(repo.root, path, line).then((editor) => notify(`Opened in ${editor}`)),
      open: () => window.moire.openWithDefault(repo.root, path).then(done(`Opened ${name}`)),
      "copy-here": () => filesIn.pickInto(menu.path),
    };
    run[action]().catch(fail);
  };
  const editorRef = useRef(openEditor);
  editorRef.current = openEditor;

  const setMode = useCallback(
    (m: CompareMode) => {
      if (m.kind === "unstaged" || m.kind === "staged" || m.kind === "all") {
        setSpecial(null);
        setSimpleMode(m.kind);
      } else {
        setSpecial(m);
        setLastPicked((p) => ({ ...p, [m.kind]: m }));
      }
    },
    [setSimpleMode],
  );

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
    grouping: () => setGrouping(grouping === "paired" ? "folder" : "paired"),
    nextNote: () => stepNote(1),
    prevNote: () => stepNote(-1),
    notes: () => (agentNotes ? setNotesPref(notesOpen ? "off" : "on") : notesHelp()),
    recentRepos: () => setRepoPicker(true),
    openRepo: pickRepo,
    stage: () =>
      actions
        ? onAct(actions === "staged" ? "unstage" : "stage", null)
        : notify(`Stage from the Unstaged view (${k("unstaged")}), unstage from Staged (${k("staged")})`),
    discard: () => (actions === "unstaged" ? onAct("discard", null) : notify(`Discard works in the Unstaged view (${k("unstaged")})`)),
    stageAll,
    discardFile,
    undo,
    extendDown: () => extendSelection(1),
    extendUp: () => extendSelection(-1),
    blinkHold: holdBlink,
    blink: () => {
      if (hunkRows.length) toggleBlink(focusHunk);
    },
    openEditor: () => editorRef.current(),
    refresh,
    cancel: () => (blink ? setBlink(null) : selection.size ? clear() : closeSearch()),
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
    layout: () => chooseLayout(shownLayout === "split" ? "unified" : "split"),
    fullFile: () => setScope(scope === "full" ? "changed" : "full"),
    preview: () => (previewable && !previewable.forced ? togglePreview() : notify("Only Markdown and SVG files switch between preview and diff")),
    theme: () => setTheme(toneOf(theme) === "dark" ? lightTheme : darkTheme),
    zoomIn: () => void window.moire.stepZoom(1),
    zoomOut: () => void window.moire.stepZoom(-1),
    zoomReset: () => void window.moire.stepZoom(0),
    help: () => setHelp(true),
    editKeys: () => {
      setHelp(false);
      window.moire.editKeys().catch((e) => notify(message(e)));
    },
  };
  const latest = useRef({ run, repo, picker, help });
  latest.current = { run, repo, picker, help };
  const runCommand = useCallback((id: CommandId) => {
    const { run, repo } = latest.current;
    if (!repo && !command(id).noRepo) return;
    if (id !== "help") setHelp(false);
    run[id]();
  }, []);

  const pending = useRef<{ stroke: string; at: number } | null>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const { run, repo, picker, help } = latest.current;
      const stroke = strokeOf(event, MAC);
      if (!stroke) return;
      const prev = pending.current && event.timeStamp - pending.current.at < SEQUENCE_MS ? pending.current.stroke : null;
      pending.current = null;
      const inField = event.target instanceof HTMLElement && !!event.target.closest("input:not([type=checkbox]), select, textarea, .file-menu");
      const id = lookup(keymapRef.current, prev, stroke);
      if (id === "prefix") {
        if (!inField && !picker && !help && repo) pending.current = { stroke, at: event.timeStamp };
        return;
      }
      if (!id) return;
      const cmd = command(id);
      if (inField && !(cmd.anywhere && stroke.startsWith("Mod+"))) return;
      if (help) {
        if (id === "help") setHelp(false);
        return;
      }
      if ((picker && stroke !== "Escape") || cmd.fixed || (!repo && !cmd.noRepo)) return;
      if (id === "copyCode" && window.getSelection()?.toString()) return;
      event.preventDefault();
      if (!(event.repeat && (cmd.hold || cmd.once))) run[id]();
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

  useDevHooks(viewRef, !!diff && (!file || file.binary || !!file.tooLarge || (!!cachedTokens && file === want) || fileContents?.tooLarge === true));

  const stagedOnly = mode.kind === "unstaged" && !files.length ? (diff?.progress?.staged ?? 0) : 0;
  const [committedSha, ...committedSubject] = committed?.split(" ") ?? [];
  const justCommitted = !!committed && !files.length && diff?.repo.head === committedSha && !special;
  const emptyCopy: Pick<React.ComponentProps<typeof NoChanges>, "copy" | "actions"> = allHidden
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
        : {};

  const toolbar = (
    <Toolbar
      root={repo?.root ?? null}
      mode={mode}
      a={diff?.a}
      b={diff?.b}
      layout={shownLayout}
      autoLayout={autoUnified}
      scope={scope}
      theme={theme}
      cvd={cvd === "on"}
      picker={picker}
      lastPicked={lastPicked}
      onPicker={setPicker}
      onMode={setMode}
      onLayout={chooseLayout}
      onScope={setScope}
      onTheme={setTheme}
      onCvd={(on) => setCvd(on ? "on" : "off")}
      onSearch={openSearch}
      notes={agentNotes ? { open: notesOpen } : null}
      onNotes={() => setNotesPref(notesOpen ? "off" : "on")}
    />
  );
  const keysHelp = help && <KeysHelp onClose={closeHelp} onEdit={() => runCommand("editKeys")} />;

  if (!repo) {
    return (
      <div className="app no-repo">
        {toolbar}
        {booting ? <div className="loading" /> : <NoRepo error={error} onPick={pickRepo} />}
        <StatusBar loadedAt={null} files={[]} error={null} actions={null} zoom={zoom} hints={false} onCommand={runCommand} />
        <Toast toast={toast} onUndo={undo} />
        {repoPicker && <RepoPicker current={null} onOpen={openRecent} onBrowse={pickRepo} onClose={closeRepoPicker} />}
        {keysHelp}
      </div>
    );
  }

  return (
    <div className={`app${notesOpen ? " has-notes" : ""}`} aria-busy={busy}>
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
            grouping={grouping}
            onGrouping={setGrouping}
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
            onSelect={setActive}
            menu={menu?.path ?? null}
            onMenu={openMenu}
            onSwitchRepo={() => setRepoPicker(true)}
            onMode={setMode}
            width={side}
            onWidth={setSideWidth}
          >
            <DropFoot drag={filesIn.drag} clash={filesIn.clash} writable={writable} ignored={dropIgnored} onCancel={filesIn.cancel} />
            {!filesIn.drag && !filesIn.clash && diff.progress && diff.progress.total > 0 && (
              <StageProgress
                staged={diff.progress.staged}
                total={diff.progress.total}
                changed={files.filter((f) => f.changedSinceStaged).length}
                hideStaged={mode.kind === "all" ? hideStaged === "on" : null}
                onHideStaged={hideStagedFiles}
                stageAll={actions === "unstaged" && files.length ? { label: allLabel("Stage"), busy, run: stageAll } : null}
              />
            )}
            {!filesIn.drag && !filesIn.clash && mode.kind === "staged" && (
              <CommitBox
                inputRef={commitInput}
                message={draft}
                busy={busy}
                staged={files.length}
                unstageLabel={allLabel("Unstage")}
                error={shownCommitError}
                onMessage={setDraft}
                onCommit={commitStaged}
                onUnstageAll={stageAll}
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
          {!file && !filesIn.clash && (!files.length || allHidden) && (
            <NoChanges mode={mode} {...emptyCopy} onBranches={() => setPicker("branches")} onAllFiles={() => showFiles("all")} />
          )}
          {filesIn.clash && (
            <>
              <ClashBar clash={filesIn.clash} onDecide={filesIn.decide} onCancel={filesIn.cancel} />
              <ClashView key={filesIn.clash.clashes[filesIn.clash.at].dest} clash={filesIn.clash} layout={shownLayout} scope={scope} />
            </>
          )}
          {file && !filesIn.clash && (
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
              layout={shownLayout}
              a={diff.a}
              b={diff.b}
              tokens={fileTokens}
              focusHunk={focusHunk}
              selection={selection}
              selCol={selCol}
              wholeHunks={!!whole || pickedHunks}
              selLines={whole ? (sideLines[whole] ?? selection.size) : selection.size}
              sideLines={sideLines}
              hits={search.inFile}
              currentHit={search.current}
              find={search.find}
              actions={file.status === "unchanged" ? null : actions}
              onExpand={(key) => setExpanded((cur) => new Set(cur).add(key))}
              onFocusHunk={setFocusHunk}
              onSelect={select}
              onAct={onAct}
              onCopy={onCopy}
              onCopyLines={onCopyLines}
              onCopySide={onCopySide}
              onPickHunk={pickHunk}
              onTextSelect={clear}
              onDiscardFile={discardFile}
              preview={preview}
              onTogglePreview={previewable && !previewable.forced ? togglePreview : null}
              blink={blink}
              onBlink={toggleBlink}
              onMenu={openMenu}
              notice={
                <>
                  {file.changedSinceStaged && <StagedNotice newEdits={diff.a.kind === "index"} onMode={setMode} />}
                  {!preview && undecoded && <EncodingNotice staging={!!actions && file.status !== "unchanged"} />}
                </>
              }
              notes={notesOpen && fileMarks ? { marks: fileMarks, chapter: currentStop === null ? null : stops[currentStop].chapter, stop: currentStop } : null}
            />
          )}
          {notesOpen && agentNotes && (
            <NotesPanel
              notes={agentNotes}
              stops={stops}
              stop={currentStop}
              shown={shownPaths}
              done={doneChapters}
              uncovered={notCovered}
              onStop={goToStop}
              onStage={actions === "unstaged" ? (c) => void stageChapter(c) : null}
              onOpen={setActive}
              onClose={() => setNotesPref("off")}
            />
          )}
        </>
      ) : (
        <div className="loading" />
      )}
      <DropSlots drag={filesIn.drag} slots={filesIn.slots} writable={writable} />
      <DropStyle drag={filesIn.drag} clash={filesIn.clash} ignored={dropIgnored} />
      <StatusBar loadedAt={loadedAt} files={files} error={error} actions={actions} zoom={zoom} notes={!!agentNotes} onCommand={runCommand} />
      <Toast toast={toast} onUndo={undo} />
      {menu && (
        <FileMenu at={menu} onDisk={files.find((f) => f.path === menu.path)?.status !== "deleted"} copyHere={writable} onPick={pickMenu} onClose={closeMenu} />
      )}
      {repoPicker && <RepoPicker current={repo.root} onOpen={openRecent} onBrowse={pickRepo} onClose={closeRepoPicker} />}
      {keysHelp}
    </div>
  );
}

function editorLine(file: FileDiff, rows: Row[], selection: ReadonlySet<string>, focusHunk: number): number {
  for (const r of selection.size ? rows : []) {
    const picked = r.t === "split" ? [r.a, r.b].some((s) => s?.sel && selection.has(s.sel)) : r.t === "uni" && !!r.line.sel && selection.has(r.line.sel);
    if (!picked || (r.t !== "split" && r.t !== "uni")) continue;
    return (r.t === "split" ? r.b?.no : r.b) ?? file.hunks[r.hunk]?.newStart ?? 1;
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
