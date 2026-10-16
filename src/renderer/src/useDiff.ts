import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CompareMode, DiffResult, RepoInfo } from "../../shared/types";
import { fileKey, remember } from "./model/files";

interface Loaded {
  view: string;
  mode: CompareMode;
  result: DiffResult;
  writes: number;
  changes: number;
}

export interface DiffEvents {
  prefetch(root: string, mode: CompareMode, result: DiffResult): Promise<void>;
  loaded(result: DiffResult, mode: CompareMode, sameView: boolean): void;
  switched(result: DiffResult, mode: CompareMode): void;
  error(e: unknown): void;
}

export function useDiff(repo: RepoInfo | null, wantMode: CompareMode, events: DiffEvents) {
  const on = useRef(events);
  on.current = events;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const viewCache = useRef(new Map<string, Loaded>());
  const writes = useRef(0);
  const changes = useRef(0);
  // A view cached before the last write or outside change shows old files, and offers actions that main then refuses as stale.
  const cachedView = (view: string) => {
    const entry = viewCache.current.get(view);
    return entry?.writes === writes.current && entry.changes === changes.current ? entry : undefined;
  };
  const loadedView = useRef<string | null>(null);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [fresh, setFresh] = useState<{ paths: ReadonlySet<string>; at: number } | null>(null);
  const loadedKeys = useRef(new Map<string, string>());
  const acting = useRef(false);
  const [busy, setBusy] = useState(false);
  const settleAt = useRef(Infinity);
  const setActing = useCallback((on: boolean) => {
    acting.current = on;
    if (on) settleAt.current = Infinity;
    setBusy(on);
  }, []);
  const startActing = useCallback(() => setActing(true), [setActing]);
  const settle = useCallback(() => {
    writes.current++;
    setRefreshTick((t) => (settleAt.current = t + 1));
  }, []);
  const refresh = useCallback(() => setRefreshTick((t) => t + 1), []);
  const reset = useCallback(() => setLoaded(null), []);

  const wantKey = JSON.stringify(wantMode);
  const wantView = `${repo?.root}:${wantKey}`;
  const shown = loaded?.view === wantView ? loaded : (cachedView(wantView) ?? loaded);

  useEffect(() => {
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [refresh]);

  useEffect(() => {
    if (!repo) return;
    window.moire.watch(repo.root).catch((e) => on.current.error(e));
    return window.moire.onRepoChanged(() => {
      changes.current++;
      refresh();
    });
  }, [repo, refresh]);

  const preloadViews = useCallback((root: string, except: string, force: boolean) => {
    for (const kind of ["unstaged", "staged", "all"] as const) {
      const view = `${root}:${JSON.stringify({ kind })}`;
      if (view === except || (!force && cachedView(view))) continue;
      const [at, seen] = [writes.current, changes.current];
      window.moire.diff(root, { kind }).then(
        (result) => remember(viewCache.current, view, { view, mode: { kind }, result, writes: at, changes: seen }),
        () => viewCache.current.delete(view),
      );
    }
  }, []);

  useEffect(() => {
    if (!repo) return;
    let stale = false;
    const view = `${repo.root}:${wantKey}`;
    const [at, seen] = [writes.current, changes.current];
    window.moire.diff(repo.root, wantMode).then(
      async (result) => {
        if (stale) return;
        await on.current.prefetch(repo.root, wantMode, result);
        if (stale) return;
        const cached = viewCache.current.get(view);
        const same = cached?.writes === at && cached.result.version === result.version;
        const next = same ? (cached.changes === seen ? cached : { ...cached, changes: seen }) : { view, mode: wantMode, result, writes: at, changes: seen };
        remember(viewCache.current, view, next);
        setLoaded(next);
        setLoadedAt(Date.now());
        const settled = acting.current && refreshTick >= settleAt.current;
        if (refreshTick >= settleAt.current) setActing(false);
        const sameView = loadedView.current === view;
        loadedView.current = view;
        if (!sameView || settled) preloadViews(repo.root, view, settled);
        const keys = new Map(result.files.map((f) => [f.path, fileKey(wantKey, f)]));
        const changed = [...keys].filter(([path, key]) => loadedKeys.current.get(path) !== key).map(([path]) => path);
        if (sameView && !acting.current && changed.length) setFresh({ paths: new Set(changed), at: Date.now() });
        loadedKeys.current = keys;
        on.current.loaded(result, wantMode, sameView);
      },
      (e) => {
        if (refreshTick >= settleAt.current) setActing(false);
        if (!stale) on.current.error(e);
      },
    );
    return () => {
      stale = true;
    };
  }, [repo, wantKey, refreshTick]);

  useLayoutEffect(() => {
    const cached = cachedView(wantView);
    if (cached) on.current.switched(cached.result, cached.mode);
  }, [wantView]);

  return {
    mode: shown?.mode ?? wantMode,
    diff: shown?.result ?? null,
    loadedAt,
    fresh,
    refreshTick,
    refresh,
    reset,
    busy,
    acting,
    startActing,
    settle,
  };
}
