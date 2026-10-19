import type { CompareMode } from "../../../shared/types";
import { Key } from "./Key";

interface Props {
  staged: number;
  total: number;
  files: { stagedFiles: number; totalFiles: number };
  changed: number;
  hideStaged: boolean | null;
  onHideStaged(hide: boolean): void;
  stageAll: { label: string; busy: boolean; run(): void } | null;
}

export function StageProgress({ staged, total, files, changed, hideStaged, onHideStaged, stageAll }: Props) {
  const tip = [
    `${staged} of ${total} changed ${total === 1 ? "line" : "lines"}`,
    `${files.stagedFiles} of ${files.totalFiles} ${files.totalFiles === 1 ? "file" : "files"} fully staged`,
    changed > 0 && `${changed} staged, then changed again`,
  ].filter(Boolean);
  return (
    <div className="stage-progress">
      <div className="stage-progress-line">
        <b data-tip={tip.join("\n")}>{staged === total ? "All staged" : `${Math.floor((staged / total) * 100)}% staged`}</b>
        {hideStaged !== null && (
          <label className="hide-staged">
            <input type="checkbox" checked={hideStaged} onChange={(e) => onHideStaged(e.target.checked)} />
            <span>Hide staged</span>
          </label>
        )}
        {stageAll && (
          <button disabled={stageAll.busy} onClick={stageAll.run}>
            {stageAll.label}
            <Key id="stageAll" />
          </button>
        )}
      </div>
      <div className="stage-bar" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={staged} aria-label="Lines staged">
        <i style={{ width: `${(staged / total) * 100}%` }} />
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
          New edits
          <Key id="unstaged" />
        </button>
        <button aria-pressed={!newEdits} onClick={() => onMode({ kind: "all" })}>
          Whole diff
          <Key id="all" />
        </button>
      </div>
    </div>
  );
}
