import type { CompareMode } from "../../../shared/types";

interface Props {
  staged: number;
  total: number;
  changed: number;
  hideStaged: boolean | null;
  onHideStaged(hide: boolean): void;
}

export function StageProgress({ staged, total, changed, hideStaged, onHideStaged }: Props) {
  const pct = (n: number) => `${(n / total) * 100}%`;
  return (
    <div className="stage-progress">
      <div className="stage-progress-line">
        <b>
          {staged} of {total} staged
        </b>
        {hideStaged !== null && (
          <label>
            <input type="checkbox" checked={hideStaged} onChange={(e) => onHideStaged(e.target.checked)} />
            Hide staged
          </label>
        )}
      </div>
      <div className="stage-bar" title={changed ? `${changed} staged, then changed again` : undefined}>
        <i style={{ width: pct(staged) }} />
        {changed > 0 && <i className="is-changed" style={{ width: pct(changed) }} />}
      </div>
    </div>
  );
}

export function StagedNotice({ newEdits, onMode }: { newEdits: boolean; onMode(mode: CompareMode): void }) {
  return (
    <div className="since">
      <p>{newEdits ? "Staged, then changed again. These are the new edits." : "Staged, then changed again. Staged lines are faded."}</p>
      <div className="seg" role="group" aria-label="Edits shown">
        <button aria-pressed={newEdits} onClick={() => onMode({ kind: "unstaged" })}>
          New edits<kbd>1</kbd>
        </button>
        <button aria-pressed={!newEdits} onClick={() => onMode({ kind: "all" })}>
          Whole diff<kbd>3</kbd>
        </button>
      </div>
    </div>
  );
}
