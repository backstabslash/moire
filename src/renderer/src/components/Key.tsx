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

// With shortcuts hidden, these buttons would otherwise have nothing on them.
export function StepKey({ id, back }: { id: CommandId; back?: boolean }) {
  return (
    <>
      <svg className="step-arrow" viewBox="0 0 14 14" aria-hidden="true">
        <path d={back ? "M8.5 3.5 5 7l3.5 3.5" : "M5.5 3.5 9 7l-3.5 3.5"} />
      </svg>
      <Key id={id} />
    </>
  );
}
