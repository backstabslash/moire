import { type HiddenLine, hiddenKinds } from "../model/invisible";

export function InvisibleNotice({ lines, onClose }: { lines: HiddenLine[]; onClose(): void }) {
  const total = lines.reduce((sum, l) => sum + l.chars.length, 0);
  return (
    <div className="invisible-notice" role="note">
      <p>{`${total} invisible ${total === 1 ? "character" : "characters"} on ${lines.length} ${lines.length === 1 ? "line" : "lines"}`}</p>
      {hiddenKinds(lines).map(({ name, point, count }) => (
        <span key={point} className="invisible-kind" data-tip={point}>
          <b>{name}</b>
          {count > 1 && count}
        </span>
      ))}
      <button className="since-close" aria-label="Close" data-tip="Hide until another invisible character appears" onClick={onClose}>
        ×
      </button>
    </div>
  );
}
