import type { Ref } from "react";
import { Key } from "./Key";

interface Props {
  inputRef?: Ref<HTMLTextAreaElement>;
  message: string;
  busy: boolean;
  staged: number;
  unstageLabel: string;
  error: string | null;
  onMessage(message: string): void;
  onCommit(): void;
  onUnstageAll(): void;
  onCopyError(): void;
  onDismissError(): void;
}

export function CommitBox({ inputRef, message, busy, staged, unstageLabel, error, onMessage, onCommit, onUnstageAll, onCopyError, onDismissError }: Props) {
  const ready = !busy && message.trim() !== "";
  return (
    <div className="commit-box">
      {staged > 0 && (
        <div className="stage-progress-line">
          <b>{staged} staged</b>
          <button disabled={busy} onClick={onUnstageAll}>
            {unstageLabel}
            <Key id="stageAll" />
          </button>
        </div>
      )}
      {error && (
        <div className="commit-error" role="alert">
          <div className="commit-error-head">
            <b>Commit failed</b>
            <button onClick={onCopyError}>Copy</button>
            <button onClick={onDismissError}>Dismiss</button>
          </div>
          <pre>{error}</pre>
        </div>
      )}
      <textarea
        ref={inputRef}
        value={message}
        rows={3}
        placeholder="Commit message"
        aria-label="Commit message"
        onChange={(e) => onMessage(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && ready) {
            e.preventDefault();
            onCommit();
          }
        }}
      />
      <button className="btn" disabled={!ready} onClick={onCommit}>
        Commit
        <kbd>{window.moire.platform === "darwin" ? "⌘↵" : "Ctrl+Enter"}</kbd>
      </button>
    </div>
  );
}
