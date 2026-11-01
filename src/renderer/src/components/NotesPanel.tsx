import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AgentNotes, NoteRange, NotesFile } from "../../../shared/types";
import { firstStopLeft, leadOf, noteSpans, shortNames, type Skim, type Stop } from "../model/notes";
import { FileGlyph } from "./FileGlyph";
import { Key, StepKey } from "./Key";
import { Lined } from "./Mark";
import { NoteSections } from "./NoteSections";
import { NoteText } from "./NoteText";
import { Resizer } from "./Resizer";
import { Screenshots } from "./Screenshots";

export const NOTES_WIDTH = { initial: 330, min: 260, max: 640 };

interface Props {
  width: number;
  onWidth(width: number): void;
  root: string;
  notes: AgentNotes;
  stops: Stop[];
  stop: number | null;
  shownPaths: ReadonlySet<string>;
  otherTab: string | null;
  doneChapters: ReadonlySet<number>;
  staged: ReadonlyMap<number, "full" | "partial">;
  stagedStops: ReadonlyMap<number, "full" | "partial">;
  skims: (Skim | null)[];
  uncovered: { path: string; count: number }[];
  commits?: NotesFile["commits"];
  onStop(index: number): void;
  onStage: ((chapter: number) => void) | null;
  onUncovered(path: string): void;
  onStep(delta: 1 | -1): void;
  onBrief(): void;
  onClose(): void;
}

export const SKIM_LABEL: Record<Skim, { label: string; tip: string }> = {
  agent: { label: "Skim", tip: "The agent says this needs only a quick look. Next step passes over it." },
  whitespace: { label: "Whitespace only", tip: "Moire checked: only indentation, line endings or blank lines changed here. Next step passes over it." },
};

export function NotesPanel({
  width,
  onWidth,
  root,
  notes,
  stops,
  stop,
  shownPaths,
  otherTab,
  doneChapters,
  staged,
  stagedStops,
  skims,
  uncovered,
  commits,
  onStop,
  onStage,
  onUncovered,
  onStep,
  onBrief,
  onClose,
}: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const current = stop === null ? null : stops[stop];
  const lead = stop === null ? null : leadOf(stops, stop);
  const looseNames = useMemo(() => shortNames(uncovered.map((u) => u.path)), [uncovered]);
  const showCurrent = () => {
    for (const at of [".chapter.is-current", ".step.is-current", ".stop.is-current"]) listRef.current?.querySelector(at)?.scrollIntoView({ block: "nearest" });
  };
  useEffect(() => {
    showCurrent();
  }, [current?.chapter, lead]);

  return (
    <aside className="notes-panel" aria-label="Agent notes">
      <Resizer className="notes-resize" label="Resize agent notes" width={width} limits={NOTES_WIDTH} growsLeft onWidth={onWidth} />
      <div className="notes-head">
        <b>Agent notes</b>
        <button className="notes-close notes-brief" data-tip="Open the brief" onClick={onBrief}>
          Brief
          <Key id="brief" />
        </button>
        <button className="notes-close" data-tip="Hide agent notes" onClick={onClose}>
          Hide
          <Key id="notes" />
        </button>
      </div>
      {notes.summary && <NotesSummary text={notes.summary} />}
      <div className="notes-scroll" ref={listRef} onLoadCapture={showCurrent}>
        <ol className="chapters">
          {notes.chapters.map((chapter, c) => {
            const open = current?.chapter === c;
            const finished = doneChapters.has(c) || staged.get(c) === "full";
            const partly = !finished && staged.get(c) === "partial";
            const from = chapter.from !== notes.chapters[c - 1]?.from ? chapter.from : undefined;
            const skim = skims[c];
            const names = shortNames(chapter.ranges.map((r) => r.path));
            return (
              <Fragment key={c}>
                {from && (
                  <li className="chapter-from" data-tip={from.summary}>
                    {from.short && <code>{from.short}</code>}
                    <span>{from.subject}</span>
                  </li>
                )}
                <li className={`chapter${open ? " is-current" : ""}${finished ? " is-done" : partly ? " is-partly" : ""}${skim ? " is-skim" : ""}`}>
                  <button
                    className="chapter-head"
                    data-tip={open ? undefined : chapterTip(chapter)}
                    onClick={() => onStop(firstStopLeft(notes, stops, c, stagedStops, shownPaths))}
                  >
                    <span className="note-no">{c + 1}</span>
                    <span className="chapter-title">
                      <span className="chapter-name">{chapter.title}</span>
                      {chapter.warn && <span className="note-warn">Check this</span>}
                      {finished && <span className="note-done">Done</span>}
                      {skim && (
                        <span className="note-skim" data-tip={SKIM_LABEL[skim].tip}>
                          {SKIM_LABEL[skim].label}
                        </span>
                      )}
                    </span>
                    {open && chapter.text && (
                      <span className="note-text">
                        <NoteText text={chapter.text} />
                      </span>
                    )}
                  </button>
                  {skim && !open && onStage && !finished && (
                    <button className="chapter-quick" aria-label={`Stage ${chapter.title}`} onClick={() => onStage(c)}>
                      Stage
                    </button>
                  )}
                  {open && (
                    <div className="chapter-body">
                      {chapter.sections && <NoteSections root={root} sections={chapter.sections} />}
                      {chapter.screenshots && <Screenshots root={root} shots={chapter.screenshots} />}
                      <ol className="steps">
                        {stepsIn(stops, c).map((step) => {
                          const note = chapter.ranges[stops[step[0]].range].note;
                          const here = stop !== null && step.includes(stop);
                          return (
                            <li key={step[0]} className={`step${here ? " is-current" : ""}`}>
                              {note && (
                                <button className="step-note" data-tip={plain(note)} onClick={() => onStop(step[0])}>
                                  <NoteText text={note} />
                                </button>
                              )}
                              <ul className="stops">
                                {step.map((index) => {
                                  const range = chapter.ranges[stops[index].range];
                                  const mark = stagedStops.get(index);
                                  const tip = mark === "full" ? "Staged" : "Partly staged";
                                  return (
                                    <li key={index}>
                                      <button
                                        className={`stop${leadOf(stops, index) === lead ? " is-current" : ""}${shownPaths.has(range.path) ? "" : " is-elsewhere"}`}
                                        data-tip={
                                          shownPaths.has(range.path)
                                            ? range.path
                                            : `${range.path}\n${otherTab ? `Not in this tab. Click to look in ${otherTab}.` : "No changes in this view"}`
                                        }
                                        onClick={() => onStop(index)}
                                      >
                                        <span className="stop-where">
                                          <FileGlyph path={range.path} />
                                          <span className="stop-name">{where(range, names)}</span>
                                          {mark && (
                                            <span className="stop-staged" role="img" aria-label={tip} data-tip={tip}>
                                              <Lined state={mark} />
                                            </span>
                                          )}
                                          {range.warn && <span className="note-warn">Check this</span>}
                                        </span>
                                      </button>
                                    </li>
                                  );
                                })}
                              </ul>
                            </li>
                          );
                        })}
                      </ol>
                    </div>
                  )}
                </li>
              </Fragment>
            );
          })}
        </ol>
        {uncovered.length > 0 && (
          <div className="uncovered">
            <b>Lines not in any chapter</b>
            {uncovered.map(({ path, count }) => (
              <button
                key={path}
                data-tip={`${path}\nGoes to the first of ${count} changed ${count === 1 ? "line" : "lines"}`}
                onClick={() => onUncovered(path)}
              >
                <FileGlyph path={path} />
                <span>{looseNames.get(path)}</span>
                <i>{count}</i>
              </button>
            ))}
          </div>
        )}
        {commits && commits.noted < commits.total && (
          <p className="notes-cover">{`Notes for ${commits.noted} of ${commits.total} ${commits.total === 1 ? "commit" : "commits"}`}</p>
        )}
      </div>
      {current && onStage && !doneChapters.has(current.chapter) && (
        <button className="btn chapter-stage" onClick={() => onStage(current.chapter)}>
          Stage this chapter
          <Key id="stageChapter" />
        </button>
      )}
      <div className="notes-foot">
        <button aria-label="Previous step" data-tip="Previous step" onClick={() => onStep(-1)}>
          <StepKey id="prevNote" back />
        </button>
        <button aria-label="Next step" data-tip="Next step" onClick={() => onStep(1)}>
          <StepKey id="nextNote" />
        </button>
        <span>step</span>
      </div>
    </aside>
  );
}

function NotesSummary({ text }: { text: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [open, setOpen] = useState(false);
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && !open) setClipped(el.scrollHeight > el.clientHeight + 1);
  }, [text, open]);
  return (
    <div className="notes-summary">
      <p ref={ref} className={open ? "is-open" : ""}>
        <NoteText text={text} />
      </p>
      {(clipped || open) && <button onClick={() => setOpen(!open)}>{open ? "Show less" : "Show more"}</button>}
    </div>
  );
}

const plain = (text: string) =>
  noteSpans(text)
    .map((s) => s.text)
    .join("");

function chapterTip(chapter: AgentNotes["chapters"][number]): string {
  return [chapter.title, ...(chapter.text ? [plain(chapter.text)] : [])].join("\n");
}

function stepsIn(stops: Stop[], chapter: number): number[][] {
  const steps: number[][] = [];
  stops.forEach((s, i) => {
    if (s.chapter === chapter) (steps[s.step] ??= []).push(i);
  });
  return steps;
}

function where(range: NoteRange, names: ReadonlyMap<string, string>): string {
  const name = names.get(range.path) ?? range.path;
  if (!range.lines) return `${name}, all changes`;
  const [start, end] = range.lines;
  return start === end ? `${name}:${start}` : `${name}:${start}–${end}`;
}
