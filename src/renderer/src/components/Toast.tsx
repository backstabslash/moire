import { useEffect, useState } from "react";

export interface ToastMsg {
  text: string;
  undo: boolean;
}

export function Toast({ toast, onUndo }: { toast: ToastMsg | null; onUndo(): void }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!toast) return;
    setShown(true);
    const id = setTimeout(() => setShown(false), 5000);
    return () => clearTimeout(id);
  }, [toast]);

  return (
    <div className={`toast${shown ? " show" : ""}`} role="status">
      <span>{toast?.text}</span>
      {toast?.undo && (
        <button onClick={onUndo}>
          Undo<kbd>u</kbd>
        </button>
      )}
    </div>
  );
}
