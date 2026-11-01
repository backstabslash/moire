import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import { forwardRef, Fragment, memo, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CommandId } from "../../../shared/keymap";
import type { CompareMode, FileDiff, SideInfo, StageAction } from "../../../shared/types";
import type { TokLines } from "../highlight/types";
import { type RowPos, textBetween } from "../model/copy";
import { familyOf } from "../model/family";
import { modeNote } from "../model/modes";
import { type NameParts, renameParts } from "../model/rename";
import { FOLD_STEP, hunkSpans, type HunkSpan, type Layout, type LineRow, type Row, type Side } from "../model/rows";
import { PREVIEW_VIEWS, type PreviewChoice, type PreviewKind, type PreviewView, readOnly, resolveView } from "../model/preview";
import { type Mark, type RowNote, rowNotes } from "../model/notes";
import type { Find, Hit } from "../model/search";
import { type Col, changedRefs, hunkRefs } from "../model/selection";
import type { Range } from "../model/words";
import type { SelectHow } from "../useSelection";
import { Code, withoutJoins } from "./Code";
import { DiffStat } from "./DiffStat";
import { FileGlyph } from "./FileGlyph";
import { Icon } from "./Icon";
import { Key, keyText, MAC, useKeymap } from "./Key";
import { Registered } from "./Mark";
import { Minimap } from "./Minimap";
import { ImagePreview, MarkdownPreview, type ReadSpot } from "./Preview";

const ROW = 21;
const HUNK_HEAD = 36;
const FOLD = 28;
const RESTORE_MS = 300;
const AUTOSCROLL_EDGE_PX = 40;
const CLEAR_OF_STICKY_HEAD_PX = 40;
const AUTOSCROLL_MAX_PX_PER_FRAME = 30;
const OLD_SIDE = 1;
const NEW_SIDE = 2;
const BOTH_SIDES = 3;
type SelectedSides = 0 | typeof OLD_SIDE | typeof NEW_SIDE | typeof BOTH_SIDES;

export interface DiffViewHandle {
  scrollToRow(index: number, align?: "start" | "center" | "auto"): void;
  showHunk?(hunk: number): void;
  scroller(): HTMLDivElement | null;
  roomy?(): boolean;
  side?(): "a" | "b";
  selectedText?(): string | null;
}

interface Props {
  file: FileDiff;
  rows: Row[];
  initialRow?: { index: number; align: "start" | "center" };
  spot?: Spot | null;
  onSpot?(spot: Spot | null): void;
  layout: Layout;
  a: SideInfo;
  b: SideInfo;
  tokens: [TokLines | null, TokLines | null] | null;
  focusHunk: number;
  selection: ReadonlySet<string>;
  selCol: Col | null;
  wholeHunks: boolean;
  selLines: number;
  sideLines: { a: number | null; b: number | null };
  hits: ReadonlyMap<string, Range[]> | null;
  currentHit: Hit | null;
  find: Find | null;
  actions: "unstaged" | "staged" | null;
  onExpand(key: string): void;
  onFocusHunk(hunk: number): void;
  onSelect(key: string, col: Col, how: SelectHow): void;
  onAct(action: StageAction, target: number | "file"): void;
  onCopy(format: "code" | "markdown", hunk: number): void;
  onCopyLines(): void;
  onCopySide(side: "a" | "b"): void;
  onPickHunk(hunk: number): void;
  onTextSelect(): void;
  onDiscardFile(): void;
  preview: Preview | null;
  onTogglePreview: (() => void) | null;
  onPreviewView(view: PreviewView): void;
  onOpenLink(path: string): void;
  blink: Blink | null;
  onBlink(hunk: number): void;
  onMenu(path: string, event: React.MouseEvent): void;
  onLineMenu(row: LineRow, side: "a" | "b" | null, event: React.MouseEvent): void;
  onStub(action: "undo" | "view", line: number): void;
  notice?: React.ReactNode;
  notes?: { marks: Mark[]; chapter: number | null; stop: number | null } | null;
  onRevealFolder?(dir: string): void;
}

export interface Blink {
  hunk: number;
  plate: "a" | "b";
}

const VIEW_NAMES: Record<PreviewView, string> = { read: "Read", changes: "Changes", sides: "Side by side" };
const SIDES_MIN_WIDTH = 1000;

export interface Preview {
  kind: PreviewKind;
  root: string;
  mode: CompareMode;
  version: string;
  text: string | null;
  old: string | null;
  view: PreviewChoice;
}

export const DiffView = forwardRef<DiffViewHandle, Props>(function DiffView(props, ref) {
  const {
    file,
    rows,
    initialRow,
    spot,
    onSpot,
    a,
    b,
    tokens,
    focusHunk,
    selection,
    selCol,
    wholeHunks,
    selLines,
    sideLines,
    hits,
    currentHit,
    find,
    actions,
    onExpand,
    onFocusHunk,
    onSelect,
    onAct,
    onCopy,
    onCopyLines,
    onCopySide,
    onPickHunk,
    onTextSelect,
    onDiscardFile,
    preview,
    onTogglePreview,
    onPreviewView,
    onOpenLink,
    blink,
    onBlink,
    onMenu,
    onLineMenu,
    onStub,
    notice,
    notes,
    onRevealFolder,
  } = props;
  const layout = file.status === "unchanged" || preview?.kind === "markdown" ? "unified" : preview ? "split" : props.layout;
  const onlyB = file.status === "added" || file.status === "untracked" || file.status === "unchanged";
  const scrollRef = useRef<HTMLDivElement>(null);
  const diffRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const [roomy, setRoomy] = useState(true);
  const measuresWidth = preview?.kind === "markdown";
  useLayoutEffect(() => {
    const main = mainRef.current;
    if (!main || !measuresWidth) return;
    const fit = () => setRoomy(main.clientWidth >= SIDES_MIN_WIDTH);
    fit();
    const resize = new ResizeObserver(fit);
    resize.observe(main);
    return () => resize.disconnect();
  }, [measuresWidth]);
  const markdownView = resolveView(preview?.view ?? "auto", roomy);
  const previewRef = useRef<DiffViewHandle>(null);
  const readSpot = useRef<ReadSpot | null>(null);
  useEffect(() => {
    if (readSpot.current?.path !== file.path) readSpot.current = null;
  }, [file.path]);
  const selectionEndRows = useRef<number[]>([]);
  const spans = useMemo(() => hunkSpans(rows), [rows]);
  const marks = notes?.marks;
  const openChapter = notes?.chapter ?? null;
  const openStop = notes?.stop ?? null;
  const previewStep = useMemo(
    () => (marks ?? []).filter((m) => m.lead === openStop).map((m) => ({ from: m.start, to: m.end, no: m.chapter + 1 })),
    [marks, openStop],
  );
  const notesByRow = useMemo(() => (marks ? rowNotes(rows, marks, openChapter, openStop) : null), [rows, marks, openChapter, openStop]);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (rows[i].t === "hunk" ? HUNK_HEAD : rows[i].t === "fold" || rows[i].t === "stub" ? FOLD : rows[i].t === "note" ? 120 : ROW),
    getItemKey: (i) => rows[i].key,
    overscan: 24,
    scrollPaddingStart: CLEAR_OF_STICKY_HEAD_PX,
    rangeExtractor: (range) => {
      const shown = defaultRangeExtractor(range);
      const pinned = spanAt(spans, range.startIndex)?.head;
      const extra = [...selectionEndRows.current, ...(pinned === undefined ? [] : [pinned])].filter((i) => i < range.count && !shown.includes(i));
      return extra.length ? [...shown, ...extra].sort((x, y) => x - y) : shown;
    },
  });
  const [pick, setPick] = useState<"a" | "b">(file.status === "deleted" ? "a" : "b");
  const pickSide = (side: "a" | "b") => {
    if (diffRef.current) diffRef.current.dataset.pick = side;
    setPick(side);
  };

  const textSelect = useRef(onTextSelect);
  textSelect.current = onTextSelect;
  useEffect(() => {
    const onChange = () => {
      const sel = window.getSelection();
      const diff = diffRef.current;
      if (!sel || sel.isCollapsed || !diff?.contains(sel.anchorNode)) return void (selectionEndRows.current = []);
      selectionEndRows.current = [rowOf(sel.anchorNode), rowOf(sel.focusNode)].filter((i) => i >= 0);
      textSelect.current();
    };
    document.addEventListener("selectionchange", onChange);
    return () => document.removeEventListener("selectionchange", onChange);
  }, []);

  const stopEdge = useRef<(() => void) | null>(null);
  useEffect(() => {
    return () => stopEdge.current?.();
  }, []);
  const edgeScroll = (col: Col, start: React.MouseEvent) => {
    const el = scrollRef.current;
    if (!el) return;
    stopEdge.current?.();
    let [x, y] = [start.clientX, start.clientY];
    let frame = 0;
    const move = (e: MouseEvent) => {
      [x, y] = [e.clientX, e.clientY];
    };
    const step = () => {
      const box = el.getBoundingClientRect();
      const into =
        y < box.top + AUTOSCROLL_EDGE_PX ? y - box.top - AUTOSCROLL_EDGE_PX : y > box.bottom - AUTOSCROLL_EDGE_PX ? y - box.bottom + AUTOSCROLL_EDGE_PX : 0;
      if (into) {
        el.scrollTop += Math.sign(into) * Math.ceil(Math.min(1, Math.abs(into) / AUTOSCROLL_EDGE_PX) * AUTOSCROLL_MAX_PX_PER_FRAME);
        const points = document.elementsFromPoint(Math.min(box.right - 1, Math.max(box.left + 1, x)), Math.min(box.bottom - 1, Math.max(box.top + 1, y)));
        const line = points
          .find((at) => at.closest(".row"))
          ?.closest(".vrow")
          ?.querySelector<HTMLElement>(`[data-line][data-col="${col}"]`);
        if (line) onSelect(line.dataset.line!, col, "drag");
      }
      frame = requestAnimationFrame(step);
    };
    const stop = () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", stop);
      stopEdge.current = null;
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", stop);
    frame = requestAnimationFrame(step);
    stopEdge.current = stop;
  };

  // Rows get measured as they render, so a few passes before the first paint land the start row exactly.
  const settling = useRef(initialRow ? 4 : 0);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!initialRow || !settling.current || !el) return;
    settling.current--;
    const [top] = virtualizer.getOffsetForIndex(initialRow.index, initialRow.align) ?? [0];
    if (Math.abs(el.scrollTop - top) < 1) return void (settling.current = 0);
    el.scrollTop = top;
    el.dispatchEvent(new Event("scroll"));
  });

  const anchor = useRef<Spot | null>(initialRow ? null : (spot ?? null));
  const shownRows = useRef(rows);
  // Rows above the anchor get measured after the first jump to it, which moves it again; so it's re-applied briefly.
  const restore = useRef<{ key: string; offset: number; until: number; top?: number } | null>(null);
  const record = () => {
    const top = scrollRef.current?.scrollTop ?? 0;
    const held = restore.current;
    if (held && performance.now() < held.until && (held.top === undefined || Math.abs(held.top - top) < 1)) return;
    restore.current = null;
    const first = virtualizer.getVirtualItemForOffset(top)?.index ?? 0;
    anchor.current = null;
    for (let i = first; i < Math.min(rows.length, first + 8); i++) {
      const line = anchorOf(rows[i]);
      if (!line) continue;
      anchor.current = { ...line, offset: virtualizer.measurementsCache[i].start - top };
      break;
    }
    onSpot?.(anchor.current);
  };
  useLayoutEffect(() => {
    if (shownRows.current === rows) return;
    shownRows.current = rows;
    const at = anchor.current;
    if (!at) return;
    const best = nearestRow(rows, at);
    if (best < 0) return;
    restore.current = { key: rows[best].key, offset: at.offset, until: performance.now() + RESTORE_MS };
  }, [rows]);
  useLayoutEffect(() => {
    if (initialRow || !spot) return;
    const best = nearestRow(rows, spot);
    if (best >= 0) restore.current = { key: rows[best].key, offset: spot.offset, until: performance.now() + RESTORE_MS };
  }, []);
  useLayoutEffect(() => {
    const at = restore.current;
    const el = scrollRef.current;
    if (!at || !el || performance.now() > at.until) return;
    const index = rows.findIndex((r) => r.key === at.key);
    const line = index < 0 ? null : anchorOf(rows[index]);
    if (!line) return;
    anchor.current = { ...line, offset: at.offset };
    const top = Math.max(0, virtualizer.measurementsCache[index].start - at.offset);
    at.top = top;
    if (Math.abs(el.scrollTop - top) < 1) return;
    el.scrollTop = top;
    // The browser caps scrollTop at the estimated height, and that isn't the user scrolling away.
    at.top = el.scrollTop;
    el.dispatchEvent(new Event("scroll"));
  });

  const selectedText = () => {
    const sel = window.getSelection();
    const diff = diffRef.current;
    if (!diff || !sel?.rangeCount || sel.isCollapsed || !diff.contains(sel.anchorNode)) return null;
    const range = sel.getRangeAt(0);
    const col: Col = layout === "split" ? pick : "u";
    const from = rowPos(diff, range.startContainer, range.startOffset, col, true);
    const to = rowPos(diff, range.endContainer, range.endOffset, col, false);
    return from && to ? textBetween(rows, col, from, to) : withoutJoins(sel.toString());
  };

  const scrollToRow: DiffViewHandle["scrollToRow"] = (index, align = "start") => {
    restore.current = null;
    if (previewRef.current) return previewRef.current.scrollToRow(index, align);
    const [offset] = virtualizer.getOffsetForIndex(index, align) ?? [0];
    if (align === "auto" && offset === scrollRef.current?.scrollTop) return;
    // Rows above can measure taller than estimated, and scrollToIndex keeps correcting until the row lands.
    virtualizer.scrollToIndex(index, { align });
  };
  useImperativeHandle(ref, () => ({
    roomy: () => roomy,
    scrollToRow,
    showHunk(hunk) {
      const index = rows.findIndex((r) => r.t === "hunk" && r.hunk === hunk);
      const el = scrollRef.current;
      const head = virtualizer.measurementsCache[index];
      if (!head || !el || previewRef.current) return;
      if (head.start >= el.scrollTop && head.end <= el.scrollTop + el.clientHeight) return;
      scrollToRow(index);
    },
    scroller: () => previewRef.current?.scroller() ?? scrollRef.current,
    side: () => pick,
    selectedText,
  }));

  const digits = useMemo(() => {
    let max = 0;
    for (const r of rows) {
      if (r.t === "split") max = Math.max(max, r.a?.no ?? 0, r.b?.no ?? 0);
      else if (r.t === "uni") max = Math.max(max, r.a ?? 0, r.b ?? 0);
    }
    return Math.max(2, String(max).length);
  }, [rows]);

  const selCount = useMemo(() => {
    const counts = new Map<number, number>();
    for (const { hunk } of changedRefs(file, selection)) counts.set(hunk, wholeHunks ? hunkRefs(file, hunk).length : (counts.get(hunk) ?? 0) + 1);
    return counts;
  }, [file, selection, wholeHunks]);
  const picked = useMemo(() => new Set([...selection].filter((k) => !k.startsWith("g")).map((k) => Number(k.split(":")[0]))), [selection]);

  const gutter = (e: React.MouseEvent, how: SelectHow) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-line]");
    if (!el) return;
    const col = el.dataset.col as Col;
    if (how !== "drag") {
      if (e.button !== 0) return;
      e.preventDefault();
      window.getSelection()?.removeAllRanges();
      if (col !== "u") pickSide(col);
      edgeScroll(col, e);
    }
    onSelect(el.dataset.line!, col, how);
  };
  const mouseDown = (e: React.MouseEvent) => {
    const side = sideOf(e.target as HTMLElement);
    if (side && e.button === 0) pickSide(side);
    gutter(e, e.shiftKey ? "shift" : (MAC ? e.metaKey : e.ctrlKey) ? "toggle" : "click");
  };
  const copyText = (e: React.ClipboardEvent<HTMLDivElement>) => {
    const text = selectedText();
    if (text === null || text === window.getSelection()?.toString()) return;
    e.preventDefault();
    e.clipboardData.setData("text/plain", text);
  };

  const oldCopy = layout === "split" || sideLines.b === null;
  const fileAction = (actions || onTogglePreview) && (
    <span className="actions">
      {onTogglePreview && (
        <button aria-pressed={!!preview} onClick={onTogglePreview}>
          <Icon name="preview" />
          <span className="lbl">Preview</span>
          <Key id="preview" />
        </button>
      )}
      {preview?.kind === "markdown" && !readOnly(file, preview.text, preview.old) && (
        <span className="md-views" role="group" aria-label="Markdown view">
          {PREVIEW_VIEWS.map((id) => (
            <button key={id} aria-pressed={markdownView === id} onClick={() => onPreviewView(id)}>
              {VIEW_NAMES[id]}
            </button>
          ))}
        </span>
      )}
      {actions && (
        <button onClick={() => onAct(actions === "staged" ? "unstage" : "stage", "file")}>
          <Icon name={actions === "staged" ? "unstage" : "stage"} />
          <span className="lbl">{actions === "staged" ? "Unstage file" : "Stage file"}</span>
        </button>
      )}
      {actions === "unstaged" && (
        <button onClick={onDiscardFile}>
          <Icon name="discard" />
          <span className="lbl">Discard file</span>
        </button>
      )}
    </span>
  );
  const shown = file.status === "deleted" ? a : b;
  const oldName = file.oldPath ?? file.path;
  const names = oldName !== file.path ? renameParts(oldName, file.path) : null;
  const modeWords = modeNote(file)?.words;
  const absentA = file.status === "added" || file.status === "untracked";
  const styles = useMemo(() => familyOf(file.path, file) === "styles", [file]);
  return (
    <main
      ref={mainRef}
      className={`main${preview ? ` is-preview preview-${preview.kind}` : file.status === "unchanged" ? " is-whole" : ""}`}
      data-plate={blink && !preview ? blink.plate : undefined}
    >
      <div className="panes-head" onContextMenu={(e) => onMenu(file.path, e)}>
        {names && layout === "split" ? (
          <>
            <PaneHead tag="a" path={oldName} parts={names[0]} side={a} diff={file}>
              <PaneCopy
                lines={selCol === "a" ? selLines : 0}
                label={sideLines.a === null ? null : "Copy old version"}
                onLines={onCopyLines}
                onFile={() => onCopySide("a")}
              />
            </PaneHead>
            <PaneHead tag="b" path={file.path} parts={names[1]} side={b} diff={file}>
              <DiffStat additions={file.additions} deletions={file.deletions} />
              {modeWords && <span className="pane-mode">{modeWords}</span>}
              <PaneCopy
                lines={selCol !== "a" ? selLines : 0}
                label={sideLines.b === null ? null : "Copy file"}
                onLines={onCopyLines}
                onFile={() => onCopySide("b")}
              />
              {fileAction}
            </PaneHead>
          </>
        ) : (
          <div className="pane-h">
            {file.status !== "unchanged" && <SideTag tag="a" side={a} absent={absentA} />}
            <SideTag tag="b" side={b} absent={file.status === "deleted"} />
            <FileGlyph path={file.path} diff={file} />
            {names ? (
              <>
                <FileName tag="a" path={oldName} parts={names[0]} tip={`${a.label}, old name\n${oldName}`} />
                <span className="pane-arrow">→</span>
                <FileName tag="b" path={file.path} parts={names[1]} tip={`${b.label}, new name\n${file.path}`} />
              </>
            ) : (
              <FileName
                tag="b"
                path={file.path}
                tip={file.status === "unchanged" ? `${b.label}, ${file.path}, unchanged` : `${a.label} → ${b.label}\n${file.path}`}
                onReveal={onRevealFolder}
              />
            )}
            <DiffStat additions={file.additions} deletions={file.deletions} />
            {modeWords && <span className="pane-mode">{modeWords}</span>}
            {oldCopy && (
              <PaneCopy
                lines={selCol === "a" ? selLines : 0}
                label={sideLines.a === null ? null : "Copy old version"}
                onLines={onCopyLines}
                onFile={() => onCopySide("a")}
              />
            )}
            <PaneCopy
              lines={oldCopy && selCol === "a" ? 0 : selLines}
              label={sideLines.b === null ? null : "Copy file"}
              onLines={onCopyLines}
              onFile={() => onCopySide("b")}
            />
            {fileAction}
          </div>
        )}
      </div>
      {notice}
      {preview?.kind === "image" && <ImagePreview root={preview.root} mode={preview.mode} file={file} a={a} b={b} version={preview.version} />}
      {preview?.kind === "markdown" && (
        <MarkdownPreview
          ref={previewRef}
          root={preview.root}
          file={file}
          rows={rows}
          side={shown}
          oldSide={a}
          text={preview.text}
          old={preview.old}
          view={markdownView}
          version={preview.version}
          focusHunk={focusHunk}
          step={previewStep}
          find={find}
          spot={readSpot}
          onFocusHunk={onFocusHunk}
          onOpenFile={onOpenLink}
        />
      )}
      {!preview && (
        <div className="scroller diff-scroller" ref={scrollRef} onScroll={record} onWheel={() => (restore.current = null)}>
          <div
            ref={diffRef}
            className={`diff${onlyB ? " only-b" : file.status === "deleted" ? " only-a" : ""}${marks ? " has-notes" : ""}`}
            data-pick={pick}
            style={{ height: virtualizer.getTotalSize(), "--digits": digits } as React.CSSProperties}
            onCopy={copyText}
            onMouseDown={mouseDown}
            onMouseOver={(e) => e.buttons === 1 && gutter(e, "drag")}
            onContextMenu={(e) => {
              const row = rows[rowOf(e.target as Node)];
              if (row?.t === "split" || row?.t === "uni") onLineMenu(row, sideOf(e.target as HTMLElement), e);
            }}
          >
            {virtualizer.getVirtualItems().map((item) => {
              const row = rows[item.index];
              const span = row.t === "hunk" ? spans.find((s) => s.head === item.index) : undefined;
              const view = (
                <RowView
                  row={row}
                  tokens={tokens}
                  focused={isFocused(row, focusHunk)}
                  selLineCount={row.t === "hunk" ? (selCount.get(row.hunk) ?? 0) : 0}
                  selSides={selectedSides(row, selection, selCol)}
                  found={findIn(row, hits, currentHit?.path === file.path ? currentHit : null)}
                  actions={actions}
                  copyable={row.t === "hunk" && picked.has(row.hunk)}
                  blinking={!!blink && "hunk" in row && row.hunk === blink.hunk}
                  styles={styles}
                  note={notesByRow?.[item.index] ?? null}
                  onExpand={onExpand}
                  onFocusHunk={onFocusHunk}
                  onAct={onAct}
                  onCopy={onCopy}
                  onBlink={onBlink}
                  onPickHunk={onPickHunk}
                  onStub={onStub}
                />
              );
              if (span) {
                const bottom = virtualizer.measurementsCache[span.end - 1]?.end ?? item.end;
                return (
                  <div key={item.key} className="vrow hunk-track" data-index={item.index} style={{ top: item.start, height: bottom - item.start }}>
                    <div className="hunk-stick" data-index={item.index} ref={virtualizer.measureElement}>
                      {view}
                    </div>
                  </div>
                );
              }
              return (
                <div
                  key={item.key}
                  className={`vrow${inFocus(row, focusHunk) ? " in-focus" : ""}`}
                  data-index={item.index}
                  ref={virtualizer.measureElement}
                  style={{ transform: `translateY(${item.start}px)` }}
                >
                  {view}
                </div>
              );
            })}
          </div>
        </div>
      )}
      {!preview && <Minimap rows={rows} hits={hits} scrollRef={scrollRef} />}
    </main>
  );
});

interface Found {
  a?: Range[];
  b?: Range[];
  curA?: number;
  curB?: number;
}
const NOTHING: Found = {};

function findIn(row: Row, hits: ReadonlyMap<string, Range[]> | null, current: Hit | null): Found {
  if (!hits || (row.t !== "split" && row.t !== "uni")) return NOTHING;
  const [a, b] = row.t === "split" ? [row.a?.sel, row.b?.sel] : [row.line.sel, undefined];
  const hitA = a ? hits.get(a) : undefined;
  const hitB = b ? hits.get(b) : undefined;
  if (!hitA && !hitB) return NOTHING;
  return { a: hitA, b: hitB, curA: a && current?.sel === a ? current.start : undefined, curB: b && current?.sel === b ? current.start : undefined };
}

interface Anchor {
  side: "a" | "b";
  no: number;
  text: string;
}

export type Spot = Anchor & { offset: number };

function nearestRow(rows: Row[], at: Anchor) {
  let best = -1;
  let distance = Infinity;
  rows.forEach((row, i) => {
    const line = anchorOf(row);
    if (!line || line.side !== at.side) return;
    const d = Math.abs(line.no - at.no) + (line.text === at.text ? 0 : 1e6);
    if (d < distance) [best, distance] = [i, d];
  });
  return best;
}

function anchorOf(row: Row): Anchor | null {
  if (row.t === "split") {
    const side = row.b ? "b" : "a";
    const line = row.b ?? row.a;
    return line ? { side, no: line.no, text: line.text } : null;
  }
  if (row.t === "uni") return { side: row.kind === "del" ? "a" : "b", no: row.line.no, text: row.line.text };
  return null;
}

function isFocused(row: Row, focusHunk: number) {
  return row.t === "hunk" && row.hunk === focusHunk;
}

function inFocus(row: Row, focusHunk: number) {
  return row.t !== "hunk" && "hunk" in row && row.hunk === focusHunk;
}

function selectedSides(row: Row, selection: ReadonlySet<string>, col: Col | null): SelectedSides {
  if (!selection.size || (row.t !== "split" && row.t !== "uni")) return 0;
  const has = (side?: Side) => !!side?.sel && selection.has(side.sel);
  if (row.t === "uni") return has(row.line) ? BOTH_SIDES : 0;
  return ((has(row.a) && col !== "b" ? OLD_SIDE : 0) | (has(row.b) && col !== "a" ? NEW_SIDE : 0)) as SelectedSides;
}

function spanAt(spans: HunkSpan[], index: number): HunkSpan | undefined {
  const span = spans.findLast((s) => s.head <= index);
  return span && index < span.end ? span : undefined;
}

function rowOf(node: Node | null): number {
  const el = node instanceof Element ? node : node?.parentElement;
  return Number(el?.closest<HTMLElement>(".vrow")?.dataset.index ?? -1);
}

function sideOf(el: HTMLElement): "a" | "b" | null {
  const cell = el.closest(".cell, .ln, .absent");
  if (!cell) return null;
  if (cell.classList.contains("a") || cell.classList.contains("del") || cell.closest(".pa")) return "a";
  if (cell.classList.contains("b") || cell.classList.contains("add") || cell.closest(".pb")) return "b";
  return null;
}

function rowPos(diff: HTMLElement, node: Node, offset: number, col: Col, start: boolean): RowPos | null {
  let el = node instanceof Element ? node : node.parentElement;
  if (el === diff) el = diff.children[start ? offset : offset - 1] ?? null;
  const index = el ? rowOf(el) : -1;
  if (index < 0) return null;
  const cell = el!.closest<HTMLElement>(".cell");
  const text = cell?.querySelector(".text");
  if (!cell || !text || (col !== "u" && sideOf(cell) !== col)) return { index };
  if (!text.contains(node)) return node === cell && offset === 0 ? { index, offset: 0 } : { index };
  const before = document.createRange();
  before.setStart(text, 0);
  before.setEnd(node, offset);
  return { index, offset: withoutJoins(before.toString()).length };
}

function PaneCopy({ lines, label, onLines, onFile }: { lines: number; label: string | null; onLines(): void; onFile(): void }) {
  if (!lines && !label) return null;
  return (
    <div className="pane-copy">
      {lines ? (
        <>
          <span className="sel-count">{`${lines} ${lines === 1 ? "line" : "lines"}`}</span>
          <button onClick={onLines}>
            <Icon name="copy" />
            <span className="lbl">Copy lines</span>
            <Key id="copyCode" />
          </button>
        </>
      ) : (
        <button onClick={onFile}>
          <Icon name="copy" />
          <span className="lbl">{label}</span>
        </button>
      )}
    </div>
  );
}

function SideTag({ tag, side, absent }: { tag: "a" | "b"; side: SideInfo; absent?: boolean }) {
  return (
    <span className={`plate-tag tag-${tag}${absent ? " is-absent" : ""}`} data-tip={absent ? `Not in ${side.label}` : side.label}>
      {tag.toUpperCase()}
    </span>
  );
}

interface PaneHeadProps {
  tag: "a" | "b";
  path: string;
  parts: NameParts;
  side: SideInfo;
  diff: FileDiff;
  children?: React.ReactNode;
}

function PaneHead({ tag, path, parts, side, diff, children }: PaneHeadProps) {
  return (
    <div className="pane-h">
      <SideTag tag={tag} side={side} />
      <FileGlyph path={path} diff={diff} />
      <FileName tag={tag} path={path} parts={parts} tip={`${side.label}, ${tag === "a" ? "old" : "new"} name\n${path}`} />
      {children}
    </div>
  );
}

interface FileNameProps {
  tag: "a" | "b";
  path: string;
  parts?: NameParts;
  tip: string;
  onReveal?(dir: string): void;
}

function FileName({ tag, path, parts, tip, onReveal }: FileNameProps) {
  if (!parts) {
    const dirs = path.split("/");
    const name = dirs.pop()!;
    return (
      <>
        {dirs.length > 0 && (
          <span className="pane-dir">
            <bdi>
              {dirs.map((dir, i) => {
                const upTo = `${dirs.slice(0, i + 1).join("/")}/`;
                return (
                  <Fragment key={upTo}>
                    <button disabled={!onReveal} data-tip={`Show in All files\n${upTo}`} onClick={() => onReveal?.(upTo)}>
                      {dir}
                    </button>
                    /
                  </Fragment>
                );
              })}
            </bdi>
          </span>
        )}
        <b data-tip={tip}>{name}</b>
      </>
    );
  }
  return (
    <b className={`pane-name renamed-${tag}`} data-tip={tip}>
      {parts[0]}
      {parts[1] && <span className={tag === "a" ? "w-del" : "w-add"}>{parts[1]}</span>}
      {parts[2]}
    </b>
  );
}

interface RowProps {
  row: Row;
  tokens: [TokLines | null, TokLines | null] | null;
  focused: boolean;
  selLineCount: number;
  selSides: SelectedSides;
  found: Found;
  actions: "unstaged" | "staged" | null;
  copyable: boolean;
  blinking: boolean;
  styles: boolean;
  note: RowNote | null;
  onExpand(key: string): void;
  onFocusHunk(hunk: number): void;
  onAct(action: StageAction, target: number | "file"): void;
  onCopy(format: "code" | "markdown", hunk: number): void;
  onBlink(hunk: number): void;
  onPickHunk(hunk: number): void;
  onStub(action: "undo" | "view", line: number): void;
}

const A_LINES = [1.5, 4.5, 7.5].map((y) => `M0 ${y}H1200`).join("");
const B_LINES = Array.from({ length: 9 }, (_, i) => `M0 ${3 * i - 16.5}L1200 ${3 * i + 1.5}`).join("");

function Grating({ shifted }: { shifted: boolean }) {
  return (
    <svg className="grating" viewBox="0 0 1200 9" preserveAspectRatio="none" aria-hidden="true">
      <path className="ga" d={A_LINES} />
      {shifted && <path className="gb" d={B_LINES} />}
    </svg>
  );
}

function FoldStep({ way, onClick }: { way: "down" | "up"; onClick(): void }) {
  const tip = way === "down" ? `Show ${FOLD_STEP} more lines below the hunk above` : `Show ${FOLD_STEP} more lines above the hunk below`;
  return <button className="fold-step" aria-label={tip} data-tip={tip} data-label={`${way === "down" ? "↓" : "↑"} ${FOLD_STEP}`} onClick={onClick} />;
}

const doneText = (done: number | undefined, count: number) => (done ? `, ${done === count ? "all" : done} staged` : "");
const doneClass = (r: { stagedEarlier?: boolean; deletionAbove?: boolean }) => `${r.stagedEarlier ? " is-done" : ""}${r.deletionAbove ? " has-cut" : ""}`;

function NonFocusingButton(props: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button {...props} onMouseDown={(e) => e.preventDefault()} />;
}

const RowView = memo(function RowView(props: RowProps) {
  const {
    row,
    tokens,
    focused,
    selLineCount,
    selSides,
    found,
    actions,
    copyable,
    blinking,
    styles,
    note,
    onExpand,
    onFocusHunk,
    onAct,
    onCopy,
    onBlink,
    onPickHunk,
    onStub,
  } = props;
  const keymap = useKeymap();
  const hint = (id: CommandId) => (keyText(keymap, id) ? ` (${keyText(keymap, id)})` : "");
  const hold = keyText(keymap, "blinkHold");
  switch (row.t) {
    case "hunk": {
      const lines = selLineCount ? ` ${selLineCount} ${selLineCount === 1 ? "line" : "lines"}` : "";
      const button = (action: StageAction, label: string, key: CommandId) => (
        <NonFocusingButton
          className={`hh-btn hh-${action}`}
          data-tip={`${label} ${selLineCount ? "the selected lines" : "this hunk"}${hint(key)}. Click or drag line numbers to pick single lines.`}
          onClick={(e) => {
            e.stopPropagation();
            onAct(action, row.hunk);
          }}
        >
          <Icon name={action} />
          <span className="lbl">
            {label}
            {lines || (action === "discard" ? "" : " hunk")}
          </span>
          <Key id={key} />
        </NonFocusingButton>
      );
      const stage = actions && (actions === "staged" ? button("unstage", "Unstage", "stage") : button("stage", "Stage", "stage"));
      const discard = actions === "unstaged" && button("discard", "Discard", "discard");
      const copy = (format: "code" | "markdown", label: string, title: string, key: CommandId) => (
        <button
          className="hh-btn hh-copy"
          data-tip={`${title}${hint(key)}`}
          onClick={(e) => {
            e.stopPropagation();
            onCopy(format, row.hunk);
          }}
        >
          <Icon name={format === "code" ? "copy" : "markdown"} />
          <span className="lbl">{label}</span>
          <Key id={key} />
        </button>
      );
      const copies = copyable && (
        <>
          {copy("code", "Copy", "Copy the selected lines", "copyCode")}
          {copy("markdown", "Markdown", "Copy the selected lines as Markdown for an agent", "copyMarkdown")}
        </>
      );
      if (row.folded) {
        const { keys, count, allWhitespaceFolds } = row.folded;
        const changed = Math.max(row.adds, row.dels);
        return (
          <div className={`hunk-head is-folded${focused ? " is-focus" : ""}`} onClick={() => onFocusHunk(row.hunk)}>
            <Grating shifted />
            <button
              className="fold-label"
              onClick={(e) => {
                e.stopPropagation();
                keys.forEach(onExpand);
              }}
            >
              {`${changed} ${changed === 1 ? "line" : "lines"}, whitespace only${count ? `, ${count} unchanged${doneText(row.folded.stagedEarlier, count)}` : ""}`}
            </button>
            {allWhitespaceFolds && (
              <button
                className="fold-label fold-all"
                data-tip="Expand every whitespace-only fold in this file"
                onClick={(e) => {
                  e.stopPropagation();
                  allWhitespaceFolds.forEach(onExpand);
                }}
              >
                Expand all
              </button>
            )}
            <span className="hh-actions">
              {copies}
              {stage}
              {discard}
            </span>
          </div>
        );
      }
      return (
        <div className={`hunk-head${focused ? " is-focus" : ""}${selLineCount ? " has-sel" : ""}`} onClick={() => onFocusHunk(row.hunk)}>
          {row.ctx && (
            <span className="hh-ctx">
              {row.ctxLine ? <Code text={row.ctxLine.text} tokens={tokens?.[row.ctxLine.plate]?.[row.ctxLine.no - 1]} mark="w-add" /> : row.ctx}
            </span>
          )}
          <span className="hh-stat">
            <span className="s-add">+{row.adds}</span> <span className="s-del">−{row.dels}</span>
          </span>
          <span
            className="hh-range"
            data-tip="Select this hunk's changed lines"
            onClick={(e) => {
              e.stopPropagation();
              onFocusHunk(row.hunk);
              onPickHunk(row.hunk);
            }}
          >
            {row.label}
          </span>
          {row.staged && (
            <span className="hh-badge">
              <Registered state={row.staged} />
              {row.staged === "full" ? "Staged" : "Partly staged"}
            </span>
          )}
          {blinking && (
            <span className="stamp">
              <span className="sa">
                <span className="plate-tag tag-a">A</span>Plate A
              </span>
              <span className="sb">
                <span className="plate-tag tag-b">B</span>Plate B
              </span>
            </span>
          )}
          <span className="hh-actions">
            <button
              className="hh-btn hh-blink"
              aria-pressed={blinking}
              data-tip={
                blinking ? `Stop blinking${hint("cancel")}` : `Flip between plate A and B${hint("blink")}.${hold ? ` Hold ${hold} to flip by hand.` : ""}`
              }
              onClick={(e) => {
                e.stopPropagation();
                onBlink(row.hunk);
              }}
            >
              <Icon name="blink" />
              <span className="lbl">{blinking ? "Stop blink" : "Blink"}</span>
              <Key id={blinking ? "cancel" : "blink"} />
            </button>
            {copies}
            {stage}
            {discard}
          </span>
        </div>
      );
    }
    case "fold":
      return (
        <div className={`fold${row.stagedEarlier ? " has-done" : ""}`}>
          <Grating shifted={false} />
          {row.steps?.down && <FoldStep way="down" onClick={() => onExpand(row.steps!.down!)} />}
          <button className="fold-open" disabled={!row.expandable} onClick={() => onExpand(row.key)}>
            {`${row.count} ${row.count === 1 ? "line" : "lines"} unchanged${doneText(row.stagedEarlier, row.count)}`}
          </button>
          {row.steps?.up && <FoldStep way="up" onClick={() => onExpand(row.steps!.up!)} />}
        </div>
      );
    case "stub":
      return (
        <div className="stub">
          <Registered state="full" />
          <span>{`Staged ${row.count} ${row.count === 1 ? "line" : "lines"}`}</span>
          {row.latest && (
            <button onClick={() => onStub("undo", row.treeLine)}>
              Undo
              <Key id="undo" />
            </button>
          )}
          <button onClick={() => onStub("view", row.treeLine)}>
            Show in Staged
            <Key id="staged" />
          </button>
        </div>
      );
    case "note":
      return (
        <div className="note">
          {row.text}
          {row.expand && (
            <button className="btn note-btn" onClick={() => onExpand(row.expand!)}>
              Show changes
            </button>
          )}
        </div>
      );
    case "split":
      if (blinking) {
        return (
          <div className="row plate">
            <PlateSide side="a" line={row.a} kind={row.kind} tokens={tokens?.[0]} hits={found.a} current={found.curA} styles={styles} />
            <PlateSide side="b" line={row.b} kind={row.kind} tokens={tokens?.[1]} hits={found.b} current={found.curB} styles={styles} />
          </div>
        );
      }
      return (
        <div className={`row split${row.faded ? " is-staged" : ""}${doneClass(row)}${note ? ` ${note.cls}` : ""}`}>
          <SplitCell
            side="a"
            line={row.a}
            kind={row.kind}
            tokens={tokens?.[0]}
            sel={!!(selSides & OLD_SIDE)}
            hits={found.a}
            current={found.curA}
            styles={styles}
          />
          <SplitCell
            side="b"
            line={row.b}
            kind={row.kind}
            tokens={tokens?.[1]}
            sel={!!(selSides & NEW_SIDE)}
            hits={found.b}
            current={found.curB}
            styles={styles}
          />
          {note && <NoteRail note={note} />}
        </div>
      );
    case "uni": {
      const cls = `${row.kind === "ctx" ? "" : row.kind}${selSides ? " sel" : ""}${row.line.staged ? " is-staged" : ""}${row.line.words ? " is-pair" : ""}`;
      const toks = row.kind === "del" ? tokens?.[0] : tokens?.[1];
      const line = row.line.sel ? { "data-line": row.line.sel, "data-col": "u" } : {};
      return (
        <div className={`row uni${row.faded ? " is-staged" : ""}${doneClass(row)}${note ? ` ${note.cls}` : ""}`}>
          <div className={`ln a ${cls}`} {...line}>
            {row.a ?? ""}
          </div>
          <div className={`ln b ${cls}`} {...line}>
            {row.b ?? ""}
          </div>
          <div className={`cell ${cls}`}>
            <div className="text">
              <Code
                text={row.line.text}
                tokens={toks?.[row.line.no - 1]}
                words={row.line.words}
                mark={row.kind === "del" ? "w-del" : "w-add"}
                hits={found.a}
                current={found.curA}
                styles={styles}
                changed={row.kind !== "ctx"}
              />
            </div>
          </div>
          {note && <NoteRail note={note} />}
        </div>
      );
    }
  }
});

function NoteRail({ note: { mark, first } }: { note: RowNote }) {
  const no = mark.chapter + 1;
  return (
    <i className="note-rail" data-tip={`Chapter ${no}: ${mark.title}`}>
      {first && <b>{no}</b>}
    </i>
  );
}

interface CellProps {
  side: "a" | "b";
  line?: Side;
  kind: "ctx" | "chg";
  tokens?: TokLines | null;
  sel: boolean;
  hits?: Range[];
  current?: number;
  styles: boolean;
}

function SplitCell({ side, line, kind, tokens, sel, hits, current, styles }: CellProps) {
  if (!line) {
    return (
      <>
        <div className={`absent ${side}`} />
      </>
    );
  }
  const cls = `${kind === "ctx" ? "" : side === "a" ? "del" : "add"}${sel ? " sel" : ""}${line.staged ? " is-staged" : ""}${line.words ? " is-pair" : ""}`;
  const attrs = line.sel ? { "data-line": line.sel, "data-col": side } : {};
  return (
    <>
      <div className={`ln ${side} ${cls}`} {...attrs}>
        {line.no}
      </div>
      <div className={`cell ${side} ${cls}`}>
        <div className="text">
          <Code
            text={line.text}
            tokens={tokens?.[line.no - 1]}
            words={line.words}
            mark={side === "a" ? "w-del" : "w-add"}
            hits={hits}
            current={current}
            styles={styles}
            changed={kind !== "ctx"}
          />
        </div>
      </div>
    </>
  );
}

function PlateSide({ side, line, kind, tokens, hits, current, styles }: Omit<CellProps, "sel">) {
  if (!line) return <div className={`p${side}`} />;
  const cls = `${kind === "ctx" ? "" : side === "a" ? "del" : "add"}${line.words ? " is-pair" : ""}`;
  return (
    <div className={`p${side}`}>
      <div className={`ln ${cls}`}>{line.no}</div>
      <div className={`cell ${cls}`}>
        <div className="text">
          <Code
            text={line.text}
            tokens={tokens?.[line.no - 1]}
            words={line.words}
            mark={side === "a" ? "w-del" : "w-add"}
            hits={hits}
            current={current}
            styles={styles}
            changed={kind !== "ctx"}
          />
        </div>
      </div>
    </div>
  );
}
