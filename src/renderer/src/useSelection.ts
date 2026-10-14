import { useCallback, useEffect, useRef, useState } from "react";
import { type Col, keysBetween } from "./model/selection";
import type { Row } from "./model/rows";

const EMPTY: ReadonlySet<string> = new Set();

export type SelectHow = "click" | "shift" | "drag";

// Click toggles a line, shift-click adds the range from the last click, and dragging adds or removes lines as it goes.
export function useSelection(rows: Row[]) {
  const [selection, setSelection] = useState(EMPTY);
  const current = useRef(selection);
  const anchor = useRef<{ key: string; col: Col } | null>(null);
  const drag = useRef<{ base: ReadonlySet<string>; adding: boolean } | null>(null);

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
        return apply(next);
      }
      const { base, adding } = how === "drag" ? drag.current! : { base: cur, adding: true };
      const next = new Set(base);
      for (const k of keysBetween(rows, col, from.key, key)) {
        if (adding) next.add(k);
        else next.delete(k);
      }
      apply(next);
    },
    [rows, apply],
  );

  const clear = useCallback(() => {
    anchor.current = null;
    if (current.current.size) apply(EMPTY);
  }, [apply]);

  return { selection, select, clear };
}
