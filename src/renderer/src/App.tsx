import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CompareMode, FileContents, FileDiff, Hunk, LineRef, RepoInfo, StageAction } from "../../shared/types";
import { CommitBox } from "./components/CommitBox";
import { type Blink, DiffView, type DiffViewHandle, type Preview } from "./components/DiffView";
import { NoChanges, NoRepo } from "./components/EmptyState";
import { FileMenu, type MenuAction, type MenuAt } from "./components/FileMenu";
import { RepoPicker } from "./components/RepoPicker";
import { SearchBar } from "./components/SearchBar";
import { StagedNotice, StageProgress } from "./components/StageProgress";
import { type FilesView, Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { DARK_IDS, LIGHT_IDS, THEME_IDS, type ThemeId, toneOf } from "./components/ThemePicker";
import { Toast, type ToastMsg } from "./components/Toast";
import { type PickerState, Toolbar } from "./components/Toolbar";
import { highlight } from "./highlight/client";
import type { TokLines } from "./highlight/types";
import { fileKey as fileKeyOf, fuzzyMatch, hashString, orderFiles, remember } from "./model/files";
import { langFor } from "./model/lang";
import { previewOf } from "./model/preview";
import { buildRows, followHunk, type Layout, type Row, type Scope } from "./model/rows";
import { copyCode, copyMarkdown } from "./model/copy";
import { changedRefs, hunkRefs } from "./model/selection";
import type { Hit } from "./model/search";
import { useDiff } from "./useDiff";
import { useSearch } from "./useSearch";
import { useSelection } from "./useSelection";
import { useStored } from "./useStored";
import { useTree } from "./useTree";

type SimpleMode = "unstaged" | "staged" | "all";

const BLINK_MS = 650;

function message(err: unknown) {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

export function App() {
  const [repo, setRepo] = useState<RepoInfo | null>(null);
  const [booting, setBooting] = useState(true);
  const [simpleMode, setSimpleMode] = useStored<SimpleMode>("mode", "unstaged", ["unstaged", "staged", "all"]);
  const [special, setSpecial] = useState<CompareMode | null>(null);
  const wantMode = useMemo<CompareMode>(() => special ?? { kind: simpleMode }, [special, simpleMode]);
  const [layout, setLayout] = useStored<Layout>("layout", "split", ["split", "unified"]);
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
  const shownFiles = useRef<string[]>([]);
  const viewRef = useRef<DiffViewHandle>(null);
  const pendingFocus = useRef<"first" | "last" | null>(null);
  const contentCache = useRef(new Map<string, FileContents>());
  const tokenCache = useRef(new Map<string, [TokLines | null, TokLines | null]>());

  const [filesView, setFilesView] = useStored<FilesView>("files", "changed", ["changed", "all"]);
  const browsing = useRef(filesView === "all");
  browsing.current = filesView === "all";
  const hidden = useCallback((m: CompareMode, f: FileDiff) => m.kind === "all" && hideStaged === "on" && f.staged === "full", [hideStaged]);
  const visible = (m: CompareMode, files: FileDiff[]) => orderFiles(files).filter((f) => !hidden(m, f));
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
      const wanted = localStorage.getItem("moire.file");
      localStorage.removeItem("moire.file");
      setActive((cur) => {
        const kept = [cur, wanted].find(has);
        if (kept || !sameView) return kept ?? ordered[0]?.path ?? null;
        const prev = shownFiles.current;
        if (cur && browsing.current && !prev.includes(cur)) return cur;
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
  const [browsed, setBrowsed] = useState<{ path: string; modeKey: string; data: FileContents } | null>(null);
  const browsedFile = useMemo(
    (): FileDiff | null =>
      browsed && {
        path: browsed.path,
        status: "unchanged",
        binary: false,
        blobs: hashString(JSON.stringify(browsed.data)),
        additions: 0,
        deletions: 0,
        hunks: [],
      },
    [browsed],
  );
  const changedFile = diff?.files.find((f) => f.path === active) ?? null;
  const file = changedFile ?? (browsedFile && browsedFile.path === active && browsed!.modeKey === modeKey ? browsedFile : null);
  const fileKey = useMemo(() => (file ? fileKeyOf(modeKey, file) : null), [file, modeKey]);

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
    document.documentElement.dataset.layout = layout;
  }, [layout]);

  useEffect(() => {
    void window.moire.zoom().then(setZoom);
    const mod = window.moire.platform === "darwin" ? "Cmd" : "Ctrl";
    return window.moire.onZoom((factor) => {
      setZoom(factor);
      setToast({ text: `Zoom ${Math.round(factor * 100)}%${factor === 1 ? "" : `. ${mod}+0 resets it.`}`, undo: false });
    });
  }, []);

  useEffect(() => {
    window.moire
      .initialRepo()
      .then(setRepo, (e) => setError(message(e)))
      .finally(() => setBooting(false));
  }, []);

  useEffect(() => {
    setExpanded(new Set());
    setFocusHunk(0);
    setBlink(null);
  }, [active, modeKey]);

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
    window.moire.fileContents(repo.root, mode, { path: active, status: "unchanged" }).then(
      (data) => !stale && setBrowsed({ path: active, modeKey, data }),
      (e) => !stale && setError(message(e)),
    );
    return () => {
      stale = true;
    };
  }, [repo, active, modeKey, refreshTick, !!diff, inDiff, filesView]);

  useEffect(() => {
    if (!repo || !file || !fileKey || file.binary || file.tooLarge) return;
    const cached = contentCache.current.get(fileKey) ?? (file === browsedFile ? browsed!.data : undefined);
    if (cached) {
      setContents({ key: fileKey, data: cached });
      return;
    }
    let stale = false;
    window.moire.fileContents(repo.root, mode, file).then(
      (data) => {
        remember(contentCache.current, fileKey, data);
        if (!stale) setContents({ key: fileKey, data });
      },
      (e) => !stale && setError(message(e)),
    );
    return () => {
      stale = true;
    };
  }, [fileKey]);

  const fileContents =
    contents?.key === fileKey ? contents.data : fileKey ? (contentCache.current.get(fileKey) ?? (file === browsedFile ? browsed!.data : null)) : null;

  useEffect(() => {
    if (!file || !fileKey || !fileContents || fileContents.tooLarge) return;
    const cached = tokenCache.current.get(fileKey);
    if (cached) {
      setTokens({ key: fileKey, data: cached });
      return;
    }
    let stale = false;
    void highlight(langFor(file.path), fileContents.a, fileContents.b).then((data) => {
      remember(tokenCache.current, fileKey, data);
      if (!stale) setTokens({ key: fileKey, data });
    });
    return () => {
      stale = true;
    };
  }, [fileContents]);

  const lastTokens = useRef<{ path: string; data: [TokLines | null, TokLines | null] } | null>(null);
  const freshTokens = tokens && fileKey && tokens.key === fileKey ? tokens.data : null;
  if (freshTokens && file) lastTokens.current = { path: file.path, data: freshTokens };
  const fileTokens = freshTokens ?? (lastTokens.current && lastTokens.current.path === file?.path ? lastTokens.current.data : null);

  const previewable = useMemo(() => (file ? previewOf(file) : null), [file]);
  const diffVersion = useMemo(() => (diff ? hashString(JSON.stringify(diff.files)) : ""), [diff]);
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
    () => (file ? buildRows(file, fileContents, { layout, scope, expanded, plates: blinkHunk }) : []),
    [file, fileContents, layout, scope, expanded, blinkHunk],
  );
  const hunkRows = useMemo(() => rows.flatMap((r, i) => (r.t === "hunk" ? [i] : [])), [rows]);

  useEffect(() => {
    setFocusHunk((f) => Math.min(f, Math.max(0, hunkRows.length - 1)));
    setBlink((b) => (b && b.hunk < hunkRows.length ? b : null));
    if (!pendingFocus.current || !hunkRows.length) return;
    const target = pendingFocus.current === "first" ? 0 : hunkRows.length - 1;
    pendingFocus.current = null;
    setFocusHunk(target);
    requestAnimationFrame(() => viewRef.current?.scrollToRow(hunkRows[target]));
  }, [hunkRows]);

  const files = useMemo(() => orderFiles(diff?.files ?? []), [diff]);
  shownFiles.current = files.map((f) => f.path);
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
  const allHidden = files.length > 0 && files.every((f) => hidden(mode, f));
  const hideStagedFiles = (hide: boolean) => {
    setHideStaged(hide ? "on" : "off");
    if (hide && changedFile?.staged === "full") setActive(files.find((f) => f.staged !== "full")?.path ?? null);
  };
  const [repoPicker, setRepoPicker] = useState(false);
  const closeRepoPicker = useCallback(() => setRepoPicker(false), []);
  const [menu, setMenu] = useState<MenuAt | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const [draft, setDraft] = useState("");

  const { selection, select, clear } = useSelection(rows);
  useEffect(() => {
    clear();
  }, [fileKey, clear]);

  const search = useSearch(repo, mode, modeKey, files, active, (e) => setError(message(e)));
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

  const pendingReveal = useRef<Hit | null>(null);
  useEffect(() => {
    if (!search.revealTick || !search.current) return;
    pendingReveal.current = search.current;
    if (search.current.path !== active) setActive(search.current.path);
  }, [search.revealTick]);

  useEffect(() => {
    const hit = pendingReveal.current;
    if (!hit || hit.path !== active) return;
    const index = rows.findIndex((r) => (r.t === "split" && (r.a?.sel === hit.sel || r.b?.sel === hit.sel)) || (r.t === "uni" && r.line.sel === hit.sel));
    const row = rows[index];
    if (row?.t === "split" || row?.t === "uni") {
      pendingReveal.current = null;
      if (row.hunk >= 0) setFocusHunk(row.hunk);
      requestAnimationFrame(() => viewRef.current?.scrollToRow(index, "center"));
      return;
    }
    const n = hit.sel.startsWith("g") ? Number(hit.sel.slice(1)) : NaN;
    const covers = (from: number, count: number) => n >= from && n < from + count;
    const keys = rows.flatMap((r) =>
      r.t === "fold" && covers(r.newFrom, r.count)
        ? [r.key]
        : r.t === "hunk" && r.folded && (hit.sel.startsWith(`${r.hunk}:`) || r.folded.gaps.some(([from, count]) => covers(from, count)))
          ? r.folded.keys
          : [],
    );
    if (keys.length) setExpanded((cur) => (keys.every((k) => cur.has(k)) ? cur : new Set([...cur, ...keys])));
  }, [rows, active, search.revealTick]);

  const actions = mode.kind === "unstaged" || mode.kind === "staged" ? mode.kind : null;
  const notify = useCallback((text: string, undo = false) => setToast({ text, undo }), []);

  const act = async (action: StageAction, target: number | "file" | null) => {
    if (!repo || !file || !actions || acting.current) return;
    if (file.status === "unchanged") return notify(`${file.path.split("/").pop()} has no changes here`);
    let lines: LineRef[] | null = null;
    const folded = file.noise && !expanded.has("noise");
    if (target !== "file" && file.hunks.length && !folded && preview?.kind !== "image") {
      const changed = changedRefs(file, selection);
      if (target === null && selection.size && !changed.length) return notify("No changed lines selected");
      const picked = changed.filter((r) => target === null || r.hunk === target);
      lines = picked.length ? picked : hunkRefs(file, target ?? focusHunk);
    }
    startActing();
    try {
      notify(await window.moire.act(repo.root, { mode: actions, action, file, lines }), true);
    } catch (e) {
      notify(message(e));
    }
    clear();
    settle();
  };
  const actRef = useRef(act);
  actRef.current = act;
  const onAct = useCallback((action: StageAction, target: number | "file" | null) => actRef.current(action, target), []);

  const toggleBlink = useCallback(
    (hunk: number) => {
      if (blinkRef.current?.hunk === hunk) return setBlink(null);
      const auto = !matchMedia("(prefers-reduced-motion: reduce)").matches;
      setFocusHunk(hunk);
      setBlink({ hunk, plate: "b", auto });
      notify(auto ? "Blinking between plate A and B. Hold b to flip by hand, Esc or Shift+B stops." : "Hold b for plate A, let go for plate B. Esc stops.");
    },
    [notify],
  );
  const holdBlink = useCallback(() => {
    if (!hunkRows.length) return;
    if (!blinkRef.current) notify("Plate A while b is held, plate B when you let go. Esc stops.");
    setBlink({ hunk: focusHunk, plate: "a", auto: false });
  }, [focusHunk, hunkRows, notify]);
  useEffect(() => {
    const onUp = (event: KeyboardEvent) => {
      if (event.key === "b") setBlink((b) => (b && !b.auto ? { ...b, plate: "b" } : b));
    };
    window.addEventListener("keyup", onUp);
    return () => window.removeEventListener("keyup", onUp);
  }, []);

  const copy = (format: "code" | "markdown") => {
    if (!file || !diff || !selection.size) {
      if (format === "markdown") notify("Select lines first: click or drag their line numbers");
      return;
    }
    const { text, count } = format === "code" ? copyCode(file, fileContents, expanded, selection) : copyMarkdown(file, fileContents, expanded, selection, diff);
    window.moire.copy(text).then(
      () => notify(`Copied ${count} ${count === 1 ? "line" : "lines"}${format === "markdown" ? " for an agent" : ""}`),
      (e) => notify(message(e)),
    );
  };
  const copyRef = useRef(copy);
  copyRef.current = copy;

  const undo = useCallback(async () => {
    if (!repo) return;
    startActing();
    try {
      const label = await window.moire.undo(repo.root);
      notify(label ? `Undid: ${label}` : "Nothing to undo");
    } catch (e) {
      notify(message(e));
    }
    settle();
  }, [repo, notify, startActing, settle]);

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
      reset();
      setFilters({ changed: "", all: "" });
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
    try {
      notify(`Committed ${await window.moire.commit(repo.root, draft.trim())}`);
      setDraft("");
    } catch (e) {
      notify(message(e));
    }
    settle();
  };

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
      reveal: () => window.moire.revealFile(repo.root, path),
      editor: () => window.moire.openInEditor(repo.root, path, line).then((editor) => notify(`Opened in ${editor}`)),
      open: () => window.moire.openWithDefault(repo.root, path).then(done(`Opened ${name}`)),
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
      }
    },
    [setSimpleMode],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "c" && !window.getSelection()?.toString()) {
        event.preventDefault();
        copyRef.current("code");
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key === "f" && repo) {
        event.preventDefault();
        openSearch();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key === "p" && repo) {
        event.preventDefault();
        filterInput.current?.focus();
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.target instanceof HTMLElement && event.target.closest("input:not([type=checkbox]), select, textarea, .file-menu")) return;
      if (picker && event.key !== "Escape") return;
      if ((event.key === "b" || event.key === "B") && event.repeat) return event.preventDefault();
      const bindings: Record<string, () => void> = {
        j: () => moveHunk(1),
        k: () => moveHunk(-1),
        "]": () => selectFile(1),
        "[": () => selectFile(-1),
        f: () => setScope(scope === "full" ? "changed" : "full"),
        v: () => setLayout(layout === "split" ? "unified" : "split"),
        t: () => setTheme(toneOf(theme) === "dark" ? lightTheme : darkTheme),
        b: holdBlink,
        B: () => hunkRows.length && toggleBlink(focusHunk),
        r: refresh,
        s: () => (actions ? onAct(actions === "staged" ? "unstage" : "stage", null) : notify("Stage from the Unstaged view (1), unstage from Staged (2)")),
        x: () => (actions === "unstaged" ? onAct("discard", null) : notify("Discard works in the Unstaged view (1)")),
        u: undo,
        c: () => copyRef.current("markdown"),
        e: () => editorRef.current(),
        m: () => (previewable && !previewable.forced ? togglePreview() : notify("Only Markdown and SVG files switch between preview and diff")),
        p: () => filterInput.current?.focus(),
        a: () => showFiles(filesView === "all" ? "changed" : "all"),
        Escape: () => (blink ? setBlink(null) : selection.size ? clear() : closeSearch()),
        "/": openSearch,
        n: () => search.step(1),
        N: () => search.step(-1),
        o: () => setRepoPicker(true),
        "1": () => setMode({ kind: "unstaged" }),
        "2": () => setMode({ kind: "staged" }),
        "3": () => setMode({ kind: "all" }),
        "4": () => setPicker("commit"),
        "5": () => setPicker("branches"),
      };
      const action = bindings[event.key];
      if (!action || !repo) {
        if (event.key === "o") setRepoPicker(true);
        return;
      }
      event.preventDefault();
      action();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    moveHunk,
    selectFile,
    scope,
    layout,
    theme,
    picker,
    repo,
    pickRepo,
    setMode,
    setScope,
    setLayout,
    setTheme,
    actions,
    onAct,
    notify,
    undo,
    clear,
    selection,
    openSearch,
    closeSearch,
    search.step,
    previewable,
    togglePreview,
    holdBlink,
    toggleBlink,
    focusHunk,
    hunkRows,
    blink,
    lightTheme,
    darkTheme,
    showFiles,
    filesView,
    refresh,
  ]);

  useDevHooks(viewRef, !!diff && (!file || file.binary || !!file.tooLarge || !!freshTokens || fileContents?.tooLarge === true));

  const toolbar = (
    <Toolbar
      root={repo?.root ?? null}
      mode={mode}
      a={diff?.a}
      b={diff?.b}
      layout={layout}
      scope={scope}
      theme={theme}
      cvd={cvd === "on"}
      picker={picker}
      onPicker={setPicker}
      onMode={setMode}
      onLayout={setLayout}
      onScope={setScope}
      onTheme={setTheme}
      onCvd={(on) => setCvd(on ? "on" : "off")}
    />
  );

  if (!repo) {
    return (
      <div className="app no-repo">
        {toolbar}
        {booting ? <div className="loading" /> : <NoRepo error={error} onPick={pickRepo} />}
        <StatusBar loadedAt={null} files={[]} error={null} actions={null} zoom={zoom} />
        {repoPicker && <RepoPicker current={null} onOpen={openRecent} onBrowse={pickRepo} onClose={closeRepoPicker} />}
      </div>
    );
  }

  return (
    <div className="app" aria-busy={busy}>
      {toolbar}
      {diff && (files.length > 0 || filesView === "all") ? (
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
          <Sidebar
            repo={repo}
            view={filesView}
            onView={showFiles}
            files={listed}
            changed={files}
            tree={tree}
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
          >
            {diff.progress && diff.progress.total > 0 && (
              <StageProgress
                staged={diff.progress.staged}
                total={diff.progress.total}
                changed={files.filter((f) => f.changedSinceStaged).length}
                hideStaged={mode.kind === "all" ? hideStaged === "on" : null}
                onHideStaged={hideStagedFiles}
              />
            )}
            {mode.kind === "staged" && <CommitBox message={draft} busy={busy} onMessage={setDraft} onCommit={commitStaged} />}
          </Sidebar>
          {!file && (!files.length || allHidden) && (
            <NoChanges
              mode={mode}
              copy={allHidden ? ["Everything is staged.", "Turn off Hide staged to see the staged files."] : undefined}
              onBranches={() => setPicker("branches")}
              onAllFiles={() => showFiles("all")}
            />
          )}
          {file && (
            <DiffView
              key={`${modeKey}:${file.path}`}
              ref={viewRef}
              file={file}
              rows={rows}
              layout={layout}
              a={diff.a}
              b={diff.b}
              tokens={fileTokens}
              focusHunk={focusHunk}
              selection={selection}
              hits={search.inFile}
              currentHit={search.current}
              actions={file.status === "unchanged" ? null : actions}
              onExpand={(key) => setExpanded((cur) => new Set(cur).add(key))}
              onFocusHunk={setFocusHunk}
              onSelect={select}
              onAct={onAct}
              preview={preview}
              onTogglePreview={previewable && !previewable.forced ? togglePreview : null}
              blink={blink}
              onBlink={toggleBlink}
              onMenu={openMenu}
              notice={file.changedSinceStaged && <StagedNotice newEdits={diff.a.kind === "index"} onMode={setMode} />}
            />
          )}
        </>
      ) : diff ? (
        <NoChanges mode={mode} onBranches={() => setPicker("branches")} onAllFiles={() => showFiles("all")} />
      ) : (
        <div className="loading" />
      )}
      <StatusBar loadedAt={loadedAt} files={files} error={error} actions={actions} zoom={zoom} />
      <Toast toast={toast} onUndo={undo} />
      {menu && <FileMenu at={menu} onDisk={files.find((f) => f.path === menu.path)?.status !== "deleted"} onPick={pickMenu} onClose={closeMenu} />}
      {repoPicker && <RepoPicker current={repo.root} onOpen={openRecent} onBrowse={pickRepo} onClose={closeRepoPicker} />}
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
