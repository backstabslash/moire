import { useEffect, useState } from "react";

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
