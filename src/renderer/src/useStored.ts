import { useCallback, useEffect, useState } from "react";

export function useStored<T extends string>(key: string, fallback: T, allowed: readonly T[] | ((value: T) => boolean)) {
  const [value, setValue] = useState<T>(() => {
    const saved = localStorage.getItem(`moire.${key}`) as T | null;
    const ok = typeof allowed === "function" ? allowed : (v: T) => allowed.includes(v);
    return saved && ok(saved) ? saved : fallback;
  });
  useEffect(() => {
    localStorage.setItem(`moire.${key}`, value);
  }, [key, value]);
  return [value, setValue] as const;
}

export function firstTime(list: string, key: string): boolean {
  const seen = JSON.parse(localStorage.getItem(`moire.${list}`) ?? "[]") as string[];
  if (seen.includes(key)) return false;
  localStorage.setItem(`moire.${list}`, JSON.stringify([...seen, key].slice(-50)));
  return true;
}

const stopsSaved = (): Record<string, number> => JSON.parse(localStorage.getItem("moire.walks") ?? "{}") as Record<string, number>;

export const savedStop = (key: string): number | null => stopsSaved()[key] ?? null;

export function saveStop(key: string, stop: number) {
  const { [key]: _, ...others } = stopsSaved();
  localStorage.setItem("moire.walks", JSON.stringify(Object.fromEntries([...Object.entries(others), [key, stop]].slice(-20))));
}

export function useStoredText(key: string) {
  const [value, setValue] = useState(() => localStorage.getItem(`moire.${key}`) ?? "");
  useEffect(() => {
    localStorage.setItem(`moire.${key}`, value);
  }, [key, value]);
  return [value, setValue] as const;
}

export function useStoredNumber(key: string, fallback: number, min: number, max: number) {
  const [value, setValue] = useState(() => {
    const saved = Number(localStorage.getItem(`moire.${key}`));
    return saved >= min && saved <= max ? saved : fallback;
  });
  useEffect(() => {
    localStorage.setItem(`moire.${key}`, String(value));
  }, [key, value]);
  return [value, setValue] as const;
}

// Updates start from what's stored, so a change made in another window isn't lost.
export function useShared<T>(key: string, read: (saved: string | null) => T) {
  const [value, setValue] = useState(() => read(localStorage.getItem(`moire.${key}`)));
  const update = useCallback(
    (change: (current: T) => T) => {
      const next = change(read(localStorage.getItem(`moire.${key}`)));
      localStorage.setItem(`moire.${key}`, JSON.stringify(next));
      setValue(next);
    },
    [key, read],
  );
  useEffect(() => {
    const changed = (e: StorageEvent) => {
      if (e.key === `moire.${key}`) setValue(read(e.newValue));
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, [key, read]);
  return [value, update] as const;
}

type Pins = Record<string, string[]>;
const NO_PINS: string[] = [];

function readPins(saved: string | null): Pins {
  try {
    const pins = JSON.parse(saved ?? "{}") as unknown;
    return pins && typeof pins === "object" && !Array.isArray(pins) ? (pins as Pins) : {};
  } catch {
    return {};
  }
}

export function usePins(repo: string | null) {
  const [all, update] = useShared("pins", readPins);
  const pins = (repo && all[repo]) || NO_PINS;
  const setPinned = useCallback(
    (path: string, on: boolean) => {
      if (!repo) return;
      update(({ [repo]: current = [], ...others }) => {
        const next = on ? (current.includes(path) ? current : [...current, path]) : current.filter((p) => p !== path);
        return next.length ? { ...others, [repo]: next } : others;
      });
    },
    [repo, update],
  );
  return [pins, setPinned] as const;
}
