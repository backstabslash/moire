import { Fragment, useMemo, useState } from "react";
import type { AgentNotes, CompareMode, FileDiff, NotesFile } from "../../../shared/types";
import { checksOf, looseTip, shortNames, type Skim, type Stop, stepCount } from "../model/notes";
import { FileGlyph } from "./FileGlyph";
import { Key } from "./Key";
import { NoteSections } from "./NoteSections";
import { NoteText } from "./NoteText";

interface Props {
  root: string;
  notes: AgentNotes;
  stops: Stop[];
  sizes: number[];
  inView: boolean[];
  skims: (Skim | null)[];
  doneChapters: ReadonlySet<number>;
  files: FileDiff[];
  uncovered: { path: string; count: number }[];
  onUncovered(path: string): void;
  commits?: NotesFile["commits"];
  view: CompareMode["kind"];
  started: boolean;
  ended: boolean;
  onStart(): void;
  onBack(): void;
  onView(view: "unstaged" | "staged"): void;
  onStop(index: number): void;
  onChapter(chapter: number): void;
  onClose(): void;
}

const count = (n: number) => n.toLocaleString("en-US");
const plural = (n: number, word: string) => `${count(n)} ${word}${n === 1 ? "" : "s"}`;
const lines = (n: number) => (n ? plural(n, "line") : "No lines to show");

function clearCopy(view: Props["view"], allDone: boolean, chapters: number) {
  if (view === "unstaged" && allDone) {
    return {
      title: "Nothing is left unstaged.",
      text: `${chapters === 1 ? "This chapter has" : `These ${count(chapters)} chapters have`} no unstaged changes. Open Staged to see what's ready to commit.`,
      go: "staged",
    } as const;
  }
  if (view === "staged")
    return { title: "Nothing from these notes is staged yet.", text: "Stage a chapter in Unstaged and it shows up here.", go: "unstaged" } as const;
  return { title: "Nothing here is left to review.", text: "None of these chapters have changes in this view." };
}

function leftAfterWalk(view: Props["view"], chapters: number, loose: string) {
  const left = [
    ...(chapters ? [`${plural(chapters, "chapter")} ${view === "unstaged" ? "still unstaged" : "in this view"}`] : []),
    ...(loose ? [`${loose} in no chapter`] : []),
  ];
  return `${left.join(" and ")}.`;
}

export function Brief({
  root,
  notes,
  stops,
  sizes,
  inView,
  skims,
  doneChapters,
  files,
  uncovered,
  onUncovered,
  commits,
  view,
  started,
  ended,
  onStart,
  onBack,
  onView,
  onStop,
  onChapter,
  onClose,
}: Props) {
  const looseNames = useMemo(() => shortNames(uncovered.map((u) => u.path)), [uncovered]);
  const [hot, setHot] = useState<number | null>(null);
  const checks = checksOf(notes, stops).filter((c) => !doneChapters.has(stops[c.stop].chapter));
  const size = (c: number) => sizes[c] ?? 0;
  const open = notes.chapters.map((_, c) => c).filter((c) => inView[c] && !doneChapters.has(c));
  const sum = (list: number[]) => list.reduce((n, c) => n + size(c), 0);
  const toRead = sum(open.filter((c) => !skims[c]));
  const toSkim = sum(open.filter((c) => skims[c]));
  const lineless = open.filter((c) => !size(c)).length;
  const loose = uncovered.reduce((n, f) => n + f.count, 0);
  const looseFiles = uncovered.filter((f) => !f.count).length;
  const looseText = [...(loose ? [plural(loose, "line")] : []), ...(looseFiles ? [plural(looseFiles, "file")] : [])].join(" and ");
  const warned = (c: number) => notes.chapters[c].warn || notes.chapters[c].ranges.some((r) => r.warn);
  const flagged = open.filter(warned).length;
  const walked = stepCount(stops.filter((s) => !skims[s.chapter])) || stepCount(stops);
  const tally = [
    ...(toRead ? [{ key: "is-read", text: `${lines(toRead)} to read` }] : []),
    ...(toSkim ? [{ key: "is-skim", text: `${count(toSkim)} to skim` }] : []),
    ...(lineless ? [{ key: "is-lineless", text: `${plural(lineless, "chapter")} with no lines to show` }] : []),
    ...(uncovered.length ? [{ key: "is-uncovered", text: `${looseFiles ? looseText : count(loose)} in no chapter` }] : []),
    ...(flagged ? [{ key: "is-warn", text: `${plural(flagged, "chapter")} to check` }] : []),
  ];
  const clear = open.length || uncovered.length ? null : clearCopy(view, doneChapters.size === notes.chapters.length, notes.chapters.length);
  const facts = [
    plural(files.length, "file"),
    `+${count(files.reduce((n, f) => n + f.additions, 0))} −${count(files.reduce((n, f) => n + f.deletions, 0))}`,
    ...(commits ? [plural(commits.total, "commit")] : []),
  ].join(", ");
  const shape = `${plural(notes.chapters.length, "chapter")}, ${plural(walked, "step")}`;
  const hover = (c: number) => ({ onMouseEnter: () => setHot(c), onMouseLeave: () => setHot(null) });
  const hotClass = (c: number) => (hot === c ? " is-hot" : "");

  return (
    <section className="brief" aria-label="Agent brief">
      <div className="brief-page">
        {notes.asked && <p className="brief-asked">{notes.asked}</p>}
        {notes.summary && (
          <p className="brief-lead">
            <NoteText text={notes.summary} />
          </p>
        )}
        {clear ? (
          <div className="brief-clear">
            <div>
              <b>{clear.title}</b>
              <span>{clear.text}</span>
            </div>
            {clear.go && (
              <button onClick={() => onView(clear.go)}>
                Open {clear.go === "staged" ? "Staged" : "Unstaged"}
                <Key id={clear.go} />
              </button>
            )}
          </div>
        ) : (
          <div>
            {ended && (
              <div className="brief-clear brief-end">
                <div>
                  <b>End of the walkthrough.</b>
                  <span>{leftAfterWalk(view, open.length, looseText)}</span>
                </div>
                <button onClick={onBack}>
                  Back to the last step
                  <Key id="prevNote" />
                </button>
              </div>
            )}
            <div className="brief-strip">
              {open.map((c) => (
                <button
                  key={c}
                  className={`strip-part${skims[c] ? " is-skim" : ""}${warned(c) ? " is-warn" : ""}${hotClass(c)}`}
                  style={{ flexGrow: Math.max(size(c), 1) }}
                  aria-label={`Chapter ${c + 1}: ${notes.chapters[c].title}, ${lines(size(c))}`}
                  data-tip={`${notes.chapters[c].title}\n${lines(size(c))}`}
                  onClick={() => onChapter(c)}
                  {...hover(c)}
                >
                  <span>{c + 1}</span>
                </button>
              ))}
              {uncovered.length > 0 && (
                <span className="strip-part is-uncovered" style={{ flexGrow: Math.max(loose, 1) }} data-tip={`Not in any chapter\n${looseText}`} />
              )}
            </div>
            <ul className="brief-tally">
              {tally.map(({ key, text }) => (
                <li key={key}>
                  <i className={`tally-key ${key}`} />
                  {text}
                </li>
              ))}
            </ul>
          </div>
        )}
        {notes.sections && (
          <div className="brief-sections">
            <NoteSections root={root} sections={notes.sections} />
          </div>
        )}
        <ol className="brief-chapters">
          {notes.chapters.map((chapter, c) => {
            const from = chapter.from !== notes.chapters[c - 1]?.from ? chapter.from : undefined;
            const done = doneChapters.has(c);
            const quiet = !!skims[c] || done;
            return (
              <Fragment key={c}>
                {from && (
                  <li className="brief-from">
                    {from.subject}
                    {!notes.summary && from.summary && (
                      <span className="brief-from-summary">
                        <NoteText text={from.summary} />
                      </span>
                    )}
                  </li>
                )}
                <li className={`brief-chapter${skims[c] ? " is-skim" : ""}${done ? " is-done" : ""}${hotClass(c)}`}>
                  <button className="brief-row" onClick={() => onChapter(c)} {...hover(c)}>
                    <span className="brief-no">{c + 1}</span>
                    <span className="brief-title">
                      {chapter.title}
                      {warned(c) && <span className="note-warn">Check this</span>}
                    </span>
                    <span className="brief-size">
                      {done
                        ? view === "unstaged"
                          ? "Nothing unstaged"
                          : "No changes left"
                        : skims[c] === "whitespace"
                          ? "Whitespace only"
                          : skims[c] && size(c)
                            ? `Skim, ${lines(size(c))}`
                            : lines(size(c))}
                    </span>
                    {chapter.text && !quiet && (
                      <span className="brief-why">
                        <NoteText text={chapter.text} />
                      </span>
                    )}
                  </button>
                  {chapter.sections && !quiet && <NoteSections root={root} sections={chapter.sections} />}
                </li>
              </Fragment>
            );
          })}
        </ol>
      </div>
      <aside className="brief-rail">
        <div className="brief-rail-head">
          <b>Agent brief</b>
          <span>
            {files.length > 0 && (
              <>
                {facts}
                <br />
              </>
            )}
            {shape}
          </span>
        </div>
        <div className="brief-calls">
          {notes.decisions && (
            <div>
              <h3>The agent decided</h3>
              <ul>
                {notes.decisions.map((d) => (
                  <li key={d}>
                    <NoteText text={d} />
                  </li>
                ))}
              </ul>
            </div>
          )}
          {checks.length > 0 && (
            <div className="brief-checks">
              <h3>Check these yourself</h3>
              <ul>
                {checks.map((c) => (
                  <li key={c.stop}>
                    <button onClick={() => onStop(c.stop)}>
                      <span className="brief-check-text">
                        <NoteText text={c.text || c.title} />
                      </span>
                      <span className="brief-check-title">{c.title}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {uncovered.length > 0 && (
            <div className="brief-loose">
              <h3>Not in any chapter</h3>
              <ul>
                {uncovered.map(({ path, count }) => (
                  <li key={path}>
                    <button data-tip={looseTip(path, count)} onClick={() => onUncovered(path)}>
                      <FileGlyph path={path} />
                      <span>{looseNames.get(path)}</span>
                      {count > 0 && <i>{count}</i>}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <div className="brief-foot">
          {!open.length ? (
            <button className="brief-back" onClick={onClose}>
              Close the brief
              <Key id="brief" />
            </button>
          ) : started ? (
            <button className="brief-start" onClick={onClose}>
              Back to the walkthrough
              <Key id="brief" />
            </button>
          ) : (
            <>
              <button className="brief-start" onClick={onStart}>
                Start the walkthrough
                <Key id="nextNote" />
              </button>
              <button className="brief-back" onClick={onClose}>
                Skip to the diff
                <Key id="brief" />
              </button>
            </>
          )}
        </div>
      </aside>
    </section>
  );
}
