import type { Caption, Skim } from "../model/notes";
import { StepKey } from "./Key";
import { NoteText } from "./NoteText";
import { SKIM_LABEL } from "./NotesPanel";

interface Props {
  staged: boolean;
  skim: Skim | null;
  onStep(delta: 1 | -1): void;
  onPlace(delta: 1 | -1): void;
  onSkip(): void;
  onStage: (() => void) | null;
}

export function StepCaption({
  chapter,
  chapters,
  title,
  step,
  steps,
  place,
  places,
  sameFile,
  text,
  warn,
  staged,
  skim,
  onStep,
  onPlace,
  onSkip,
  onStage,
}: Caption & Props) {
  return (
    <div className={`caption${staged ? " is-staged" : ""}`} role="status">
      <b className="caption-no">{chapter}</b>
      <p className="caption-text">
        <NoteText text={text || title} />
      </p>
      <span className="caption-keys">
        <button aria-label="Previous step" data-tip="Previous step" onClick={() => onStep(-1)}>
          <StepKey id="prevNote" back />
        </button>
        <button aria-label="Next step" data-tip="Next step" onClick={() => onStep(1)}>
          <StepKey id="nextNote" />
        </button>
      </span>
      <p className="caption-where">
        {staged && <span className="caption-staged">Staged</span>}
        {warn && <span className="note-warn">Check this</span>}
        {skim && (
          <span className="note-skim" data-tip={SKIM_LABEL[skim].tip}>
            {SKIM_LABEL[skim].label}
          </span>
        )}
        <span className="caption-count">
          Chapter {chapter} of {chapters}
        </span>
        {text && (
          <span className="caption-title" data-tip={title}>
            {title}
          </span>
        )}
        {steps > 1 && (
          <span className="caption-count">
            step {step} of {steps}
          </span>
        )}
        {places > 1 ? (
          <span className="caption-place">
            <button aria-label="Previous place" data-tip="Previous place in this step" onClick={() => onPlace(-1)}>
              <StepKey id="prevPlace" back />
            </button>
            place {place} of {places}
            <button aria-label="Next place" data-tip="Next place in this step" onClick={() => onPlace(1)}>
              <StepKey id="nextPlace" />
            </button>
          </span>
        ) : (
          sameFile > 1 && <span className="caption-count">{sameFile} places in this file</span>
        )}
        {skim && (
          <span className="caption-acts">
            <button onClick={onSkip}>Skip chapter</button>
            {onStage && <button onClick={onStage}>Stage chapter</button>}
          </span>
        )}
      </p>
    </div>
  );
}
