import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import { forwardRef, memo, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CommandId } from "../../../shared/keymap";
import type { CompareMode, FileDiff, SideInfo, StageAction } from "../../../shared/types";
import type { TokLines } from "../highlight/types";
import { type RowPos, textBetween } from "../model/copy";
import { modeNote } from "../model/modes";
import { type NameParts, renameParts } from "../model/rename";
import type { Layout, Row, Side } from "../model/rows";
import type { PreviewKind } from "../model/preview";
import { type Mark, newLineOf, noteClass } from "../model/notes";
import type { Find, Hit } from "../model/search";
import { type Col, changedRefs, hunkRefs } from "../model/selection";
import type { Range } from "../model/words";
import type { SelectHow } from "../useSelection";
import { Code, hangingIndent, withoutJoins } from "./Code";
import { Key, keyText, MAC, useKeymap } from "./Key";
import { Registered } from "./Mark";
import { Minimap } from "./Minimap";
import { ImagePreview, MarkdownPreview } from "./Preview";

const ROW = 21;
const HUNK_HEAD = 36;
const FOLD = 28;
const RESTORE_MS = 300;
const AUTOSCROLL_EDGE_PX = 40;
const AUTOSCROLL_MAX_PX_PER_FRAME = 30;
const OLD_SIDE = 1;
const NEW_SIDE = 2;
const BOTH_SIDES = 3;
type SelectedSides = 0 | typeof OLD_SIDE | typeof NEW_SIDE | typeof BOTH_SIDES;

export interface DiffViewHandle {
  scrollToRow(index: number, align?: "start" | "center" | "auto"): void;
  scroller(): HTMLDivElement | null;
  side?(): "a" | "b";
}

interface Props {
  file: FileDiff;
  rows: Row[];
  initialRow?: { index: number; align: "start" | "center" };
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
  blink: Blink | null;
  onBlink(hunk: number): void;
  onMenu(path: string, event: React.MouseEvent): void;
  onStub(action: "undo" | "view", line: number): void;
  notice?: React.ReactNode;
  notes?: { marks: Mark[]; chapter: number | null; stop: number | null } | null;
}

export interface Blink {
  hunk: number;
  plate: "a" | "b";
}

export interface Preview {
  kind: PreviewKind;
  root: string;
  mode: CompareMode;
  version: string;
  text: string | null;
}

export const DiffView = forwardRef<DiffViewHandle, Props>(function DiffView(props, ref) {
  const {
    file,
    rows,
    initialRow,
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
    blink,
    onBlink,
    onMenu,
    onStub,
    notice,
    notes,
  } = props;
  const layout = file.status === "unchanged" || preview?.kind === "markdown" ? "unified" : preview ? "split" : props.layout;
  const onlyB = file.status === "added" || file.status === "untracked" || file.status === "unchanged";
  const scrollRef = useRef<HTMLDivElement>(null);
  const diffRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<DiffViewHandle>(null);
  const selectionEndRows = useRef<number[]>([]);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (rows[i].t === "hunk" ? HUNK_HEAD : rows[i].t === "fold" || rows[i].t === "stub" ? FOLD : rows[i].t === "note" ? 120 : ROW),
    getItemKey: (i) => rows[i].key,
    overscan: 24,
    rangeExtractor: (range) => {
      const shown = defaultRangeExtractor(range);
      const extra = selectionEndRows.current.filter((i) => i < range.count && !shown.includes(i));
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
        const at = document.elementFromPoint(Math.min(box.right - 1, Math.max(box.left + 1, x)), Math.min(box.bottom - 1, Math.max(box.top + 1, y)));
        const line = at?.closest(".vrow")?.querySelector<HTMLElement>(`[data-line][data-col="${col}"]`);
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
    const [offset] = virtualizer.getOffsetForIndex(initialRow.index, initialRow.align) ?? [0];
    const top = Math.max(0, initialRow.align === "start" ? offset - 40 : offset);
    if (Math.abs(el.scrollTop - top) < 1) return void (settling.current = 0);
    el.scrollTop = top;
    el.dispatchEvent(new Event("scroll"));
  });

  const anchor = useRef<(Anchor & { offset: number }) | null>(null);
  const shownRows = useRef(rows);
  // Rows above the anchor get measured after the first jump to it, which moves it again; so it's re-applied briefly.
  const restore = useRef<{ key: string; offset: number; until: number } | null>(null);
  const record = () => {
    if (restore.current && performance.now() < restore.current.until) return;
    restore.current = null;
    const top = scrollRef.current?.scrollTop ?? 0;
    const first = virtualizer.getVirtualItemForOffset(top)?.index ?? 0;
    anchor.current = null;
    for (let i = first; i < Math.min(rows.length, first + 8); i++) {
      const line = anchorOf(rows[i]);
      if (!line) continue;
      anchor.current = { ...line, offset: virtualizer.measurementsCache[i].start - top };
      return;
    }
  };
  useLayoutEffect(() => {
    if (shownRows.current === rows) return;
    shownRows.current = rows;
    const at = anchor.current;
    if (!at) return;
    let best = -1;
    let distance = Infinity;
    rows.forEach((row, i) => {
      const line = anchorOf(row);
      if (!line || line.side !== at.side) return;
      const d = Math.abs(line.no - at.no) + (line.text === at.text ? 0 : 1e6);
      if (d < distance) [best, distance] = [i, d];
    });
    if (best < 0) return;
    restore.current = { key: rows[best].key, offset: at.offset, until: performance.now() + RESTORE_MS };
  }, [rows]);
  useLayoutEffect(() => {
    const at = restore.current;
    const el = scrollRef.current;
    if (!at || !el || performance.now() > at.until) return;
    const index = rows.findIndex((r) => r.key === at.key);
    const line = index < 0 ? null : anchorOf(rows[index]);
    if (!line) return;
    anchor.current = { ...line, offset: at.offset };
    const top = Math.max(0, virtualizer.measurementsCache[index].start - at.offset);
    if (Math.abs(el.scrollTop - top) >= 1) el.scrollTop = top;
  });

  useImperativeHandle(ref, () => ({
    scrollToRow(index, align = "start") {
      restore.current = null;
      if (previewRef.current) return previewRef.current.scrollToRow(index, align);
      const [offset] = virtualizer.getOffsetForIndex(index, align) ?? [0];
      if (align === "auto" && offset === scrollRef.current?.scrollTop) return;
      scrollRef.current?.scrollTo({ top: Math.max(0, align === "start" ? offset - 40 : offset) });
    },
    scroller: () => previewRef.current?.scroller() ?? scrollRef.current,
    side: () => pick,
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
    const sel = window.getSelection();
    if (!sel?.rangeCount || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    const col: Col = layout === "split" ? pick : "u";
    const from = rowPos(e.currentTarget, range.startContainer, range.startOffset, col, true);
    const to = rowPos(e.currentTarget, range.endContainer, range.endOffset, col, false);
    const native = sel.toString();
    const text = from && to ? textBetween(rows, col, from, to) : withoutJoins(native);
    if (text === native) return;
    e.preventDefault();
    e.clipboardData.setData("text/plain", text);
  };

  const fileAction = (actions || onTogglePreview) && (
    <span className="actions">
      {onTogglePreview && (
        <button aria-pressed={!!preview} onClick={onTogglePreview}>
          Preview
          <Key id="preview" />
        </button>
      )}
      {actions && (
        <button onClick={() => onAct(actions === "staged" ? "unstage" : "stage", "file")}>{actions === "staged" ? "Unstage file" : "Stage file"}</button>
      )}
      {actions === "unstaged" && <button onClick={onDiscardFile}>Discard file</button>}
    </span>
  );
  const shown = file.status === "deleted" ? a : b;
  const oldName = file.oldPath ?? file.path;
  const names = oldName !== file.path ? renameParts(oldName, file.path) : null;
  const modeWords = modeNote(file)?.words;
  return (
    <main
      className={`main${preview ? ` is-preview preview-${preview.kind}` : file.status === "unchanged" ? " is-whole" : ""}`}
      data-plate={blink && !preview ? blink.plate : undefined}
    >
      <div className="panes-head" onContextMenu={(e) => onMenu(file.path, e)}>
        {layout === "split" ? (
          <>
            <PaneHead tag="a" path={oldName} parts={names?.[0]} side={a} absent={file.status === "added" || file.status === "untracked"}>
              <PaneCopy
                lines={selCol === "a" ? selLines : 0}
                label={sideLines.a === null ? null : "Copy old version"}
                onLines={onCopyLines}
                onFile={() => onCopySide("a")}
              />
            </PaneHead>
            <PaneHead tag="b" path={file.path} parts={names?.[1]} side={b} absent={file.status === "deleted"}>
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
            {file.status !== "unchanged" && <span className="plate-tag tag-a">A</span>}
            <span className="plate-tag tag-b">B</span>
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
              />
            )}
            {modeWords && <span className="pane-mode">{modeWords}</span>}
            <PaneCopy
              lines={selLines}
              label={sideLines.b !== null ? "Copy file" : sideLines.a !== null ? "Copy old version" : null}
              onLines={onCopyLines}
              onFile={() => onCopySide(sideLines.b !== null ? "b" : "a")}
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
          text={preview.text}
          version={preview.version}
          focusHunk={focusHunk}
          find={find}
          onFocusHunk={onFocusHunk}
        />
      )}
      {!preview && (
        <div className="scroller diff-scroller" ref={scrollRef} onScroll={record} onWheel={() => (restore.current = null)}>
          <div
            ref={diffRef}
            className={`diff${onlyB ? " only-b" : file.status === "deleted" ? " only-a" : ""}`}
            data-pick={pick}
            style={{ height: virtualizer.getTotalSize(), "--digits": digits } as React.CSSProperties}
            onCopy={copyText}
            onMouseDown={mouseDown}
            onMouseOver={(e) => e.buttons === 1 && gutter(e, "drag")}
          >
            {virtualizer.getVirtualItems().map((item) => {
              const row = rows[item.index];
              return (
                <div
                  key={item.key}
                  className={`vrow${inFocus(row, focusHunk) ? " in-focus" : ""}`}
                  data-index={item.index}
                  ref={virtualizer.measureElement}
                  style={{ transform: `translateY(${item.start}px)` }}
                >
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
                    note={notes ? noteClass(newLineOf(row), notes.marks, notes.chapter, notes.stop) : ""}
                    onExpand={onExpand}
                    onFocusHunk={onFocusHunk}
                    onAct={onAct}
                    onCopy={onCopy}
                    onBlink={onBlink}
                    onPickHunk={onPickHunk}
                    onStub={onStub}
                  />
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

function rowOf(node: Node | null): number {
  const el = node instanceof Element ? node : node?.parentElement;
  return Number(el?.closest<HTMLElement>(".vrow")?.dataset.index ?? -1);
}

function sideOf(el: HTMLElement): "a" | "b" | null {
  const cell = el.closest(".cell");
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
            Copy lines
            <Key id="copyCode" />
          </button>
        </>
      ) : (
        <button onClick={onFile}>{label}</button>
      )}
    </div>
  );
}

interface PaneHeadProps {
  tag: "a" | "b";
  path: string;
  parts?: NameParts;
  side: SideInfo;
  absent: boolean;
  children?: React.ReactNode;
}

function PaneHead({ tag, path, parts, side, absent, children }: PaneHeadProps) {
  const tip = `${side.label}${parts ? (tag === "a" ? ", old name" : ", new name") : ""}\n${path}`;
  return (
    <div className="pane-h">
      <span className={`plate-tag tag-${tag}`} data-tip={side.label}>
        {tag.toUpperCase()}
      </span>
      {absent ? <span className="pane-absent">Not in {side.label}</span> : <FileName tag={tag} path={path} parts={parts} tip={tip} />}
      {children}
    </div>
  );
}

function FileName({ tag, path, parts, tip }: { tag: "a" | "b"; path: string; parts?: NameParts; tip: string }) {
  if (!parts) return <b data-tip={tip}>{path.split("/").pop()}</b>;
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
  note: string;
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
          title={`${label} ${selLineCount ? "the selected lines" : "this hunk"}${hint(key)}. Click or drag line numbers to pick single lines.`}
          onClick={(e) => {
            e.stopPropagation();
            onAct(action, row.hunk);
          }}
        >
          {label}
          {lines || (action === "discard" ? "" : " hunk")}
          <Key id={key} />
        </NonFocusingButton>
      );
      const stage = actions && (actions === "staged" ? button("unstage", "Unstage", "stage") : button("stage", "Stage", "stage"));
      const discard = actions === "unstaged" && button("discard", "Discard", "discard");
      const copy = (format: "code" | "markdown", label: string, title: string, key: CommandId) => (
        <button
          className="hh-btn hh-copy"
          title={`${title}${hint(key)}`}
          onClick={(e) => {
            e.stopPropagation();
            onCopy(format, row.hunk);
          }}
        >
          {label}
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
              {`${changed} ${changed === 1 ? "line" : "lines"} · whitespace only${count ? ` · ${count} unchanged${doneText(row.folded.stagedEarlier, count)}` : ""}`}
            </button>
            {allWhitespaceFolds && (
              <button
                className="fold-label fold-all"
                title="Expand every whitespace-only fold in this file"
                onClick={(e) => {
                  e.stopPropagation();
                  allWhitespaceFolds.forEach(onExpand);
                }}
              >
                · expand all
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
          <span
            className="hh-range"
            title="Select this hunk's changed lines"
            onClick={(e) => {
              e.stopPropagation();
              onFocusHunk(row.hunk);
              onPickHunk(row.hunk);
            }}
          >
            {row.label}
          </span>
          <span className="hh-ctx">{row.ctx}</span>
          <span className="hh-stat">
            <span className="s-add">+{row.adds}</span> <span className="s-del">−{row.dels}</span>
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
              title={blinking ? `Stop blinking${hint("cancel")}` : `Flip between plate A and B${hint("blink")}.${hold ? ` Hold ${hold} to flip by hand.` : ""}`}
              onClick={(e) => {
                e.stopPropagation();
                onBlink(row.hunk);
              }}
            >
              {blinking ? "Stop blink" : "Blink"}
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
        <button className={`fold${row.stagedEarlier ? " has-done" : ""}`} disabled={!row.expandable} onClick={() => onExpand(row.key)}>
          <Grating shifted={false} />
          <span>{`${row.count} ${row.count === 1 ? "line" : "lines"} unchanged${doneText(row.stagedEarlier, row.count)}`}</span>
        </button>
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
            <PlateSide side="a" line={row.a} kind={row.kind} tokens={tokens?.[0]} hits={found.a} current={found.curA} />
            <PlateSide side="b" line={row.b} kind={row.kind} tokens={tokens?.[1]} hits={found.b} current={found.curB} />
          </div>
        );
      }
      return (
        <div className={`row split${row.faded ? " is-staged" : ""}${doneClass(row)}${note ? ` ${note}` : ""}`}>
          <SplitCell side="a" line={row.a} kind={row.kind} tokens={tokens?.[0]} sel={!!(selSides & OLD_SIDE)} hits={found.a} current={found.curA} />
          <SplitCell side="b" line={row.b} kind={row.kind} tokens={tokens?.[1]} sel={!!(selSides & NEW_SIDE)} hits={found.b} current={found.curB} />
        </div>
      );
    case "uni": {
      const cls = `${row.kind === "ctx" ? "" : row.kind}${selSides ? " sel" : ""}${row.line.staged ? " is-staged" : ""}`;
      const toks = row.kind === "del" ? tokens?.[0] : tokens?.[1];
      const line = row.line.sel ? { "data-line": row.line.sel, "data-col": "u" } : {};
      return (
        <div className={`row uni${row.faded ? " is-staged" : ""}${doneClass(row)}${note ? ` ${note}` : ""}`}>
          <div className={`ln a ${cls}`} {...line}>
            {row.a ?? ""}
          </div>
          <div className={`ln b ${cls}`} {...line}>
            {row.b ?? ""}
          </div>
          <div className={`cell ${cls}`} style={hangingIndent(row.line.text)}>
            <div className="text">
              <Code
                text={row.line.text}
                tokens={toks?.[row.line.no - 1]}
                words={row.line.words}
                mark={row.kind === "del" ? "w-del" : "w-add"}
                hits={found.a}
                current={found.curA}
              />
            </div>
          </div>
        </div>
      );
    }
  }
});

interface CellProps {
  side: "a" | "b";
  line?: Side;
  kind: "ctx" | "chg";
  tokens?: TokLines | null;
  sel: boolean;
  hits?: Range[];
  current?: number;
}

function SplitCell({ side, line, kind, tokens, sel, hits, current }: CellProps) {
  if (!line) {
    return (
      <>
        <div className={`absent ${side}`} />
      </>
    );
  }
  const cls = `${kind === "ctx" ? "" : side === "a" ? "del" : "add"}${sel ? " sel" : ""}${line.staged ? " is-staged" : ""}`;
  const attrs = line.sel ? { "data-line": line.sel, "data-col": side } : {};
  return (
    <>
      <div className={`ln ${side} ${cls}`} {...attrs}>
        {line.no}
      </div>
      <div className={`cell ${side} ${cls}`} style={hangingIndent(line.text)}>
        <div className="text">
          <Code text={line.text} tokens={tokens?.[line.no - 1]} words={line.words} mark={side === "a" ? "w-del" : "w-add"} hits={hits} current={current} />
        </div>
      </div>
    </>
  );
}

function PlateSide({ side, line, kind, tokens, hits, current }: Omit<CellProps, "sel">) {
  if (!line) return <div className={`p${side}`} />;
  const cls = kind === "ctx" ? "" : side === "a" ? "del" : "add";
  return (
    <div className={`p${side}`}>
      <div className={`ln ${cls}`}>{line.no}</div>
      <div className={`cell ${cls}`} style={hangingIndent(line.text)}>
        <div className="text">
          <Code text={line.text} tokens={tokens?.[line.no - 1]} words={line.words} mark={side === "a" ? "w-del" : "w-add"} hits={hits} current={current} />
        </div>
      </div>
    </div>
  );
}
