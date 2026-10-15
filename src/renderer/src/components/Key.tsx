import { useSyncExternalStore } from "react";
import { type CommandId, DEFAULT_KEYMAP, type Keymap, keyLabel } from "../../../shared/keymap";

export const MAC = window.moire.platform === "darwin";

let current = DEFAULT_KEYMAP;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function setKeymap(keymap: Keymap): void {
  current = keymap;
  for (const listener of listeners) listener();
}

export const useKeymap = () => useSyncExternalStore(subscribe, () => current);
export const keyText = (keymap: Keymap, id: CommandId) => keyLabel(keymap, id, MAC, "text");

export function Key({ id }: { id: CommandId }) {
  const label = keyLabel(useKeymap(), id, MAC);
  return label ? <kbd>{label}</kbd> : null;
}
