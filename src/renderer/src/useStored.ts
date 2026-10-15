import { useEffect, useState } from "react";

export function useStored<T extends string>(key: string, fallback: T, allowed: readonly T[]) {
  const [value, setValue] = useState<T>(() => {
    const saved = localStorage.getItem(`moire.${key}`) as T | null;
    return saved && allowed.includes(saved) ? saved : fallback;
  });
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
