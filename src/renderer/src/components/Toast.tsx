import { useEffect, useState } from "react";
import { Key } from "./Key";

export interface ToastMsg {
  text: string;
  undo: boolean;
  choices?: { label: string; pick(): void }[];
}

export function Toast({ toast, onUndo }: { toast: ToastMsg | null; onUndo(): void }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    setShown(!!toast);
    if (!toast || toast.choices) return;
    const id = setTimeout(() => setShown(false), 5000);
    return () => clearTimeout(id);
  }, [toast]);

  return (
    <div className={`toast${shown ? " show" : ""}`} role="status">
      <span>{toast?.text}</span>
      {toast?.undo && (
        <button onClick={onUndo}>
          Undo
          <Key id="undo" />
        </button>
      )}
      {toast?.choices?.map((c) => (
        <button key={c.label} onClick={c.pick}>
          {c.label}
        </button>
      ))}
    </div>
  );
}
