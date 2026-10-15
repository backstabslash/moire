interface Props {
  message: string;
  busy: boolean;
  onMessage(message: string): void;
  onCommit(): void;
}

export function CommitBox({ message, busy, onMessage, onCommit }: Props) {
  const ready = !busy && message.trim() !== "";
  return (
    <div className="commit-box">
      <textarea
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
