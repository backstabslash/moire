import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AgentNotes, NoteRange } from "../../../shared/types";
import { noteSpans, type Stop } from "../model/notes";
import { FileGlyph } from "./FileGlyph";
import { Key } from "./Key";
import { Lined } from "./Mark";
import { Resizer } from "./Resizer";

export const NOTES_WIDTH = { initial: 330, min: 260, max: 640 };

interface Props {
  width: number;
  onWidth(width: number): void;
  notes: AgentNotes;
  stops: Stop[];
  stop: number | null;
  shownPaths: ReadonlySet<string>;
  otherTab: string | null;
  doneChapters: ReadonlySet<number>;
  staged: ReadonlyMap<number, "full" | "partial">;
  stagedStops: ReadonlyMap<number, "full" | "partial">;
  uncovered: { path: string; count: number }[];
  onStop(index: number): void;
  onStage: ((chapter: number) => void) | null;
  onOpen(path: string): void;
  onClose(): void;
}

export function NotesPanel({
  width,
  onWidth,
  notes,
  stops,
  stop,
  shownPaths,
  otherTab,
  doneChapters,
  staged,
  stagedStops,
  uncovered,
  onStop,
  onStage,
  onOpen,
  onClose,
}: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const current = stop === null ? null : stops[stop];
  useEffect(() => {
    listRef.current?.querySelector(".chapter.is-current")?.scrollIntoView({ block: "nearest" });
  }, [current?.chapter]);
  const first = (chapter: number) => stops.findIndex((s) => s.chapter === chapter);
  const firstLeft = (chapter: number) => {
    const left = stops.findIndex(
      (s, i) => s.chapter === chapter && stagedStops.get(i) !== "full" && shownPaths.has(notes.chapters[chapter].ranges[s.range].path),
    );
    return left >= 0 ? left : first(chapter);
  };

  return (
    <aside className="notes-panel" aria-label="Agent notes">
      <Resizer className="notes-resize" label="Resize agent notes" width={width} limits={NOTES_WIDTH} growsLeft onWidth={onWidth} />
      <div className="notes-head">
        <b>Agent notes</b>
        <button className="notes-close" data-tip="Hide agent notes" onClick={onClose}>
          Hide
          <Key id="notes" />
        </button>
      </div>
      {notes.summary && <NotesSummary text={notes.summary} />}
      <div className="notes-scroll" ref={listRef}>
        <ol className="chapters">
          {notes.chapters.map((chapter, c) => {
            const open = current?.chapter === c;
            const finished = doneChapters.has(c) || staged.get(c) === "full";
            const partly = !finished && staged.get(c) === "partial";
            return (
              <li key={c} className={`chapter${open ? " is-current" : ""}${finished ? " is-done" : partly ? " is-partly" : ""}`}>
                <button className="chapter-head" data-tip={open ? undefined : chapterTip(chapter)} onClick={() => onStop(firstLeft(c))}>
                  <span className="note-no">{c + 1}</span>
                  <span className="chapter-title">
                    <span className="chapter-name">{chapter.title}</span>
                    {chapter.warn && <span className="note-warn">Check this</span>}
                  </span>
                  {open && chapter.text && (
                    <span className="note-text">
                      <NoteText text={chapter.text} />
                    </span>
                  )}
                </button>
                {open && (
                  <div className="chapter-body">
                    <ul className="stops">
                      {chapter.ranges.map((range, r) => {
                        const index = first(c) + r;
                        const mark = stagedStops.get(index);
                        const tip = mark === "full" ? "Staged" : "Partly staged";
                        return (
                          <li key={r}>
                            <button
                              className={`stop${index === stop ? " is-current" : ""}${shownPaths.has(range.path) ? "" : " is-elsewhere"}`}
                              data-tip={
                                shownPaths.has(range.path)
                                  ? range.path
                                  : `${range.path}\n${otherTab ? `Not in this tab. Click to look in ${otherTab}.` : "No changes in this view"}`
                              }
                              onClick={() => onStop(index)}
                            >
                              <span className="stop-where">
                                <FileGlyph path={range.path} />
                                {where(range)}
                                {mark && (
                                  <span className="stop-staged" role="img" aria-label={tip} data-tip={tip}>
                                    <Lined state={mark} />
                                  </span>
                                )}
                                {range.warn && <span className="note-warn">Check this</span>}
                              </span>
                              {range.note && (
                                <span className="stop-note">
                                  <NoteText text={range.note} />
                                </span>
                              )}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                    {onStage && !doneChapters.has(c) && (
                      <button className="chapter-stage" onClick={() => onStage(c)}>
                        Stage this chapter
                      </button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
        {uncovered.length > 0 && (
          <div className="uncovered">
            <b>Not in any chapter</b>
            {uncovered.map(({ path, count }) => (
              <button key={path} data-tip={`${path}\n${count} changed ${count === 1 ? "line" : "lines"}`} onClick={() => onOpen(path)}>
                <FileGlyph path={path} />
                <span>{path.split("/").pop()}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="notes-foot">
        <Key id="prevNote" />
        <Key id="nextNote" />
        <span>previous / next</span>
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

function chapterTip(chapter: AgentNotes["chapters"][number]): string {
  return [
    chapter.title,
    ...(chapter.text
      ? [
          noteSpans(chapter.text)
            .map((s) => s.text)
            .join(""),
        ]
      : []),
  ].join("\n");
}

function where(range: NoteRange): string {
  const name = range.path.split("/").pop() ?? range.path;
  if (!range.lines) return `${name}, all changes`;
  const [start, end] = range.lines;
  return start === end ? `${name}:${start}` : `${name}:${start}–${end}`;
}

function NoteText({ text }: { text: string }) {
  return <>{noteSpans(text).map((s, i) => (s.code ? <code key={i}>{s.text}</code> : s.text))}</>;
}
