import type { CompareMode } from "../../../shared/types";
import { Rings } from "./Mark";

const COPY: Record<CompareMode["kind"], [string, string]> = {
  unstaged: ["Nothing unstaged.", "The working tree matches the index. Changes show up when you come back to this window or press r."],
  staged: ["Nothing staged.", "The index matches HEAD."],
  all: ["Working tree matches HEAD.", "When an agent saves a file, its changes show up when you come back to this window or press r."],
  commit: ["This commit changes nothing.", "It may be a merge or an empty commit."],
  branches: ["Nothing to review.", "The branch has no changes since it split from the base."],
};

interface NoChangesProps {
  mode: CompareMode;
  copy?: [string, string];
  onBranches(): void;
  onAllFiles(): void;
}

export function NoChanges({ mode, copy, onBranches, onAllFiles }: NoChangesProps) {
  const [title, text] = copy ?? COPY[mode.kind];
  return (
    <div className="empty-state">
      <div className="empty-inner">
        <Rings />
        <div>
          <h2>{title}</h2>
          <p>{text}</p>
          <div className="empty-actions">
            {mode.kind !== "branches" && (
              <button className="btn" onClick={onBranches}>
                Compare with a branch
                <kbd>5</kbd>
              </button>
            )}
            <button className="btn" onClick={onAllFiles}>
              All files
              <kbd>a</kbd>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function NoRepo({ error, onPick }: { error: string | null; onPick(): void }) {
  return (
    <div className="empty-state">
      <div className="empty-inner">
        <Rings />
        <div>
          <h2>Open a repository.</h2>
          <p>
            Pick a folder with a git repository, or start moire from a terminal with <code>moire path/to/repo</code>.
          </p>
          {error && <p className="s-del">{error}</p>}
          <button className="btn" onClick={onPick}>
            Choose folder
            <kbd>o</kbd>
          </button>
        </div>
      </div>
    </div>
  );
}
