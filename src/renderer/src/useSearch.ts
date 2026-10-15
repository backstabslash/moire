import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { CompareMode, FileContents, FileDiff, RepoInfo } from "../../shared/types";
import { fileKey } from "./model/files";
import { compile, type Hit, MAX_HITS, type SearchOptions, searchFile } from "./model/search";
import type { Range } from "./model/words";

const sameHit = (x: Hit | null, y: Hit | null) => !!x && !!y && x.path === y.path && x.sel === y.sel && x.start === y.start;

export function useSearch(
  repo: RepoInfo | null,
  mode: CompareMode,
  modeKey: string,
  allFiles: FileDiff[],
  active: string | null,
  onError: (e: unknown) => void,
) {
  const files = useMemo(() => allFiles.filter((f) => !f.noise), [allFiles]);
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<SearchOptions>({ query: "", matchCase: false, regex: false, side: "both" });
  const deferred = useDeferredValue(options);
  const [contents, setContents] = useState<ReadonlyMap<string, FileContents>>(new Map());
  const [current, setCurrent] = useState<Hit | null>(null);
  const [failed, setFailed] = useState(false);
  const [revealTick, setRevealTick] = useState(0);
  const loaded = useRef(contents);
  loaded.current = contents;
  const searching = open && options.query !== "";

  useEffect(() => {
    if (!searching || !repo) return;
    const missing = files.filter((f) => !f.binary && !f.tooLarge && !loaded.current.has(fileKey(modeKey, f)));
    if (!missing.length) return;
    let stale = false;
    setFailed(false);
    window.moire.manyContents(repo.root, mode, missing).then(
      (data) => {
        if (stale) return;
        setContents((cur) => {
          const next = new Map<string, FileContents>();
          for (const f of files) {
            const key = fileKey(modeKey, f);
            const have = cur.get(key);
            if (have) next.set(key, have);
          }
          missing.forEach((f, i) => next.set(fileKey(modeKey, f), data[i]));
          return next;
        });
      },
      (e) => {
        if (stale) return;
        setFailed(true);
        onError(e);
      },
    );
    return () => {
      stale = true;
    };
  }, [searching, repo, modeKey, files]);

  const pattern = useMemo(() => (open ? compile(deferred) : null), [open, deferred]);
  const hits = useMemo(() => {
    if (!(pattern instanceof RegExp)) return [];
    const out: Hit[] = [];
    for (const f of files) {
      if (out.length >= MAX_HITS) break;
      out.push(...searchFile(f, contents.get(fileKey(modeKey, f)) ?? null, pattern, deferred.side, MAX_HITS - out.length));
    }
    return out;
  }, [pattern, files, contents, modeKey, deferred.side]);

  const ready = files.every((f) => f.binary || f.tooLarge || contents.has(fileKey(modeKey, f)));

  const picked = useRef<typeof pattern>(null);
  useEffect(() => {
    if (!ready) return;
    const fresh = picked.current !== pattern;
    picked.current = pattern;
    if (!fresh && hits.some((h) => sameHit(h, current))) return;
    const next = hits.find((h) => h.path === active) ?? hits[0] ?? null;
    setCurrent(next);
    if (next && fresh) setRevealTick((t) => t + 1);
  }, [hits, ready]);

  const index = hits.findIndex((h) => sameHit(h, current));
  const step = useCallback(
    (delta: number) => {
      if (!hits.length) return;
      setCurrent(hits[(index + delta + hits.length) % hits.length]);
      setRevealTick((t) => t + 1);
    },
    [hits, index],
  );

  const counts = useMemo(() => {
    if (!open || !(pattern instanceof RegExp)) return null;
    const out = new Map<string, number>();
    for (const h of hits) out.set(h.path, (out.get(h.path) ?? 0) + 1);
    return out;
  }, [open, pattern, hits]);

  const inFile = useMemo(() => {
    if (!counts) return null;
    const out = new Map<string, Range[]>();
    for (const h of hits) {
      if (h.path !== active) continue;
      const list = out.get(h.sel);
      if (list) list.push([h.start, h.end]);
      else out.set(h.sel, [[h.start, h.end]]);
    }
    return out;
  }, [counts, hits, active]);

  return {
    open,
    setOpen,
    options,
    setOptions,
    invalid: pattern === "invalid",
    loading: !ready && !failed,
    total: hits.length,
    index,
    current: open ? current : null,
    counts,
    inFile,
    revealTick,
    step,
  };
}
