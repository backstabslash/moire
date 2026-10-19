import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type Col, columnKeys, keysBetween, sideKeys } from "./model/selection";
import type { Row } from "./model/rows";

const EMPTY: ReadonlySet<string> = new Set();

export type SelectHow = "click" | "toggle" | "shift" | "drag";

interface Picked {
  keys: ReadonlySet<string>;
  col: Col | null;
  wholeSide: "a" | "b" | null;
  fromHunkHeaders: boolean;
}

const NONE: Picked = { keys: EMPTY, col: null, wholeSide: null, fromHunkHeaders: false };

export function useSelection(rows: Row[]) {
  const [picked, setPicked] = useState(NONE);
  const current = useRef(picked);
  const anchor = useRef<{ key: string; col: Col } | null>(null);
  const drag = useRef<{ base: ReadonlySet<string>; adding: boolean } | null>(null);
  const cursor = useRef<{ key: string; base: ReadonlySet<string> } | null>(null);

  useEffect(() => {
    const up = () => {
      drag.current = null;
    };
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);

  const apply = useCallback((keys: ReadonlySet<string>, col: Col | null, wholeSide: "a" | "b" | null = null, fromHunkHeaders = false) => {
    const next = keys.size || wholeSide ? { keys, col, wholeSide, fromHunkHeaders } : NONE;
    current.current = next;
    setPicked(next);
  }, []);

  const select = useCallback(
    (key: string, col: Col, how: SelectHow) => {
      const from = anchor.current;
      if (how === "drag") {
        const d = drag.current;
        if (!d || from?.col !== col) return;
        const next = new Set(d.base);
        for (const k of keysBetween(rows, col, from.key, key)) {
          if (d.adding) next.add(k);
          else next.delete(k);
        }
        if (cursor.current) cursor.current.key = key;
        return apply(next, col);
      }
      if (how === "shift" && from?.col === col && cursor.current) {
        const { base } = cursor.current;
        cursor.current.key = key;
        drag.current = { base, adding: true };
        return apply(new Set([...base, ...keysBetween(rows, col, from.key, key)]), col);
      }
      const { keys, col: had, wholeSide } = current.current;
      const before = how === "toggle" && had === col && !wholeSide ? keys : EMPTY;
      const adding = !before.has(key);
      const next = new Set(before);
      if (adding) next.add(key);
      else next.delete(key);
      const base = adding ? before : next;
      anchor.current = { key, col };
      drag.current = { base, adding };
      cursor.current = { key, base };
      apply(next, col);
    },
    [rows, apply],
  );

  const selectAll = useCallback(
    (side: "a" | "b") => {
      anchor.current = null;
      cursor.current = null;
      apply(EMPTY, side, side);
    },
    [apply],
  );

  const pick = useCallback(
    (keys: string[], col: Col, fromHunkHeaders = false) => {
      if (!keys.length) return;
      anchor.current = { key: keys[0], col };
      cursor.current = { key: keys[keys.length - 1], base: EMPTY };
      apply(new Set(keys), col, null, fromHunkHeaders);
    },
    [apply],
  );

  const extend = useCallback(
    (delta: number): string | null => {
      const from = anchor.current;
      const at = cursor.current;
      if (!from || !at) return null;
      const keys = columnKeys(rows, from.col);
      const i = keys.indexOf(at.key);
      const to = keys[i + delta];
      if (i < 0 || !to) return at.key;
      at.key = to;
      apply(new Set([...at.base, ...keysBetween(rows, from.col, from.key, to)]), from.col);
      return to;
    },
    [rows, apply],
  );

  const clear = useCallback(() => {
    anchor.current = null;
    cursor.current = null;
    if (current.current !== NONE) apply(EMPTY, null);
  }, [apply]);

  const carry = useCallback(
    (map: ReadonlyMap<string, string> | null) => {
      if (!map) return clear();
      const moved = (k: string) => map.get(k) ?? k;
      const from = anchor.current;
      anchor.current = from && map.has(from.key) ? { ...from, key: moved(from.key) } : null;
      const at = cursor.current;
      cursor.current = at && anchor.current && map.has(at.key) ? { key: moved(at.key), base: new Set([...at.base].map(moved)) } : null;
      apply(new Set([...current.current.keys].map(moved)), current.current.col, null, current.current.fromHunkHeaders);
    },
    [apply, clear],
  );

  const selection = useMemo(() => (picked.wholeSide ? new Set(sideKeys(rows, picked.wholeSide)) : picked.keys), [picked, rows]);
  return { selection, col: picked.col, wholeSide: picked.wholeSide, fromHunkHeaders: picked.fromHunkHeaders, select, selectAll, pick, extend, clear, carry };
}
