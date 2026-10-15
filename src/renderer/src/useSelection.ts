import { useCallback, useEffect, useRef, useState } from "react";
import { type Col, columnKeys, keysBetween } from "./model/selection";
import type { Row } from "./model/rows";

const EMPTY: ReadonlySet<string> = new Set();

export type SelectHow = "click" | "shift" | "drag";

export function useSelection(rows: Row[]) {
  const [selection, setSelection] = useState(EMPTY);
  const current = useRef(selection);
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

  const apply = useCallback((next: ReadonlySet<string>) => {
    current.current = next;
    setSelection(next);
  }, []);

  const select = useCallback(
    (key: string, col: Col, how: SelectHow) => {
      const cur = current.current;
      const from = anchor.current;
      if (how === "drag" && (!drag.current || from?.col !== col)) return;
      if (how === "click" || !from || from.col !== col) {
        const adding = !cur.has(key);
        anchor.current = { key, col };
        drag.current = { base: cur, adding };
        const next = new Set(cur);
        if (adding) next.add(key);
        else next.delete(key);
        cursor.current = { key, base: adding ? cur : next };
        return apply(next);
      }
      const { base, adding } = how === "drag" ? drag.current! : { base: cur, adding: true };
      const next = new Set(base);
      for (const k of keysBetween(rows, col, from.key, key)) {
        if (adding) next.add(k);
        else next.delete(k);
      }
      if (cursor.current) cursor.current.key = key;
      apply(next);
    },
    [rows, apply],
  );

  // Moves the end of the last range by one line, growing or shrinking it from the clicked line.
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
      apply(new Set([...at.base, ...keysBetween(rows, from.col, from.key, to)]));
      return to;
    },
    [rows, apply],
  );

  const clear = useCallback(() => {
    anchor.current = null;
    cursor.current = null;
    if (current.current.size) apply(EMPTY);
  }, [apply]);

  const carry = useCallback(
    (map: ReadonlyMap<string, string> | null) => {
      if (!map) return clear();
      const moved = (k: string) => map.get(k) ?? k;
      const from = anchor.current;
      anchor.current = from && map.has(from.key) ? { ...from, key: moved(from.key) } : null;
      const at = cursor.current;
      cursor.current = at && anchor.current && map.has(at.key) ? { key: moved(at.key), base: new Set([...at.base].map(moved)) } : null;
      apply(new Set([...current.current].map(moved)));
    },
    [apply, clear],
  );

  return { selection, select, extend, clear, carry };
}
