import { useVirtualizer } from "@tanstack/react-virtual";
import { forwardRef, memo, useImperativeHandle, useLayoutEffect, useMemo, useRef } from "react";
import type { CompareMode, FileDiff, SideInfo, StageAction } from "../../../shared/types";
import type { TokLines } from "../highlight/types";
import type { Layout, Row, Side } from "../model/rows";
import type { PreviewKind } from "../model/preview";
import type { Hit } from "../model/search";
import { type Col, changedRefs } from "../model/selection";
import type { Range } from "../model/words";
import type { SelectHow } from "../useSelection";
import { Code, hangingIndent } from "./Code";
import { Minimap } from "./Minimap";
import { ImagePreview, MarkdownPreview } from "./Preview";

const ROW = 21;
const HUNK_HEAD = 36;
const FOLD = 28;

export interface DiffViewHandle {
  scrollToRow(index: number, align?: "start" | "center"): void;
  scroller(): HTMLDivElement | null;
}

interface Props {
  file: FileDiff;
  rows: Row[];
  layout: Layout;
  a: SideInfo;
  b: SideInfo;
  tokens: [TokLines | null, TokLines | null] | null;
  focusHunk: number;
  selection: ReadonlySet<string>;
  hits: ReadonlyMap<string, Range[]> | null;
  currentHit: Hit | null;
  // which actions this view offers, null when it's read-only
  actions: "unstaged" | "staged" | null;
  onExpand(key: string): void;
  onFocusHunk(hunk: number): void;
  onSelect(key: string, col: Col, how: SelectHow): void;
  onAct(action: StageAction, target: number | "file"): void;
  // shown instead of the diff when set
  preview: Preview | null;
  // set when the file can switch between preview and diff
  onTogglePreview: (() => void) | null;
  // the hunk shown one plate at a time, and which plate is up
  blink: Blink | null;
  onBlink(hunk: number): void;
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
  const { file, rows, a, b, tokens, focusHunk, selection, hits, currentHit, actions, onExpand, onFocusHunk, onSelect, onAct, preview, onTogglePreview, blink, onBlink } = props;
  // Images sit side by side and Markdown renders one version, whatever the diff layout.
  const layout = preview?.kind === "image" ? "split" : preview ? "unified" : props.layout;
  const scrollRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<DiffViewHandle>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (rows[i].t === "hunk" ? HUNK_HEAD : rows[i].t === "fold" ? FOLD : rows[i].t === "note" ? 120 : ROW),
    getItemKey: (i) => rows[i].key,
    overscan: 24,
  });

  // The line at the top of the view, so a refresh that adds or removes lines above it doesn't move what you're reading.
  const anchor = useRef<(Anchor & { offset: number }) | null>(null);
  const shownRows = useRef(rows);
  const record = () => {
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
    scrollRef.current?.scrollTo({ top: Math.max(0, virtualizer.measurementsCache[best].start - at.offset) });
  }, [rows]);

  useImperativeHandle(ref, () => ({
    scrollToRow(index, align = "start") {
      if (previewRef.current) return previewRef.current.scrollToRow(index, align);
      const [offset] = virtualizer.getOffsetForIndex(index, align) ?? [0];
      scrollRef.current?.scrollTo({ top: Math.max(0, align === "start" ? offset - 40 : offset) });
    },
    scroller: () => scrollRef.current,
  }));

  // Hunk buttons count only the lines staging will act on.
  const selCount = useMemo(() => {
    const counts = new Map<number, number>();
    for (const { hunk } of changedRefs(file, selection)) counts.set(hunk, (counts.get(hunk) ?? 0) + 1);
    return counts;
  }, [file, selection]);

  const gutter = (e: React.MouseEvent, how: SelectHow) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-line]");
    if (!el) return;
    if (how !== "drag") {
      if (e.button !== 0) return;
      e.preventDefault();
    }
    onSelect(el.dataset.line!, el.dataset.col as Col, how);
  };

  const fileAction = (actions || onTogglePreview) && (
    <span className="actions">
      {onTogglePreview && (
        <button aria-pressed={!!preview} onClick={onTogglePreview}>
          Preview<kbd>m</kbd>
        </button>
      )}
      {actions && <button onClick={() => onAct(actions === "staged" ? "unstage" : "stage", "file")}>{actions === "staged" ? "Unstage file" : "Stage file"}</button>}
    </span>
  );
  const shown = file.status === "deleted" ? a : b;
  const oldName = file.oldPath ?? file.path;
  return (
    <main className={`main${preview ? ` is-preview preview-${preview.kind}` : ""}`} data-plate={blink && !preview ? blink.plate : undefined}>
      <div className="panes-head">
        {layout === "split" ? (
          <>
            <PaneHead tag="a" name={file.status === "added" || file.status === "untracked" ? "" : oldName} side={a} />
            <PaneHead tag="b" name={file.status === "deleted" ? "" : file.path} side={b}>
              {fileAction}
            </PaneHead>
          </>
        ) : (
          <div className="pane-h">
            <span className="plate-tag tag-a">A</span>
            <span className="plate-tag tag-b">B</span>
            <b>{file.path.split("/").pop()}</b>
            <span>{file.path}</span>
            {fileAction}
          </div>
        )}
        {!preview && (
          <div className="mini-h">
            <span className="plate-tag tag-a">A</span>
            <span className="plate-tag tag-b">B</span>
          </div>
        )}
      </div>
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
          onFocusHunk={onFocusHunk}
        />
      )}
      {!preview && (
        <div className="scroller" ref={scrollRef} onScroll={record}>
          <div
            // A file that exists on one side only has nothing to show in the other side's number column.
            className={`diff${file.status === "added" || file.status === "untracked" ? " only-b" : file.status === "deleted" ? " only-a" : ""}`}
            style={{ height: virtualizer.getTotalSize() }}
            onMouseDown={(e) => gutter(e, e.shiftKey ? "shift" : "click")}
            onMouseOver={(e) => e.buttons === 1 && gutter(e, "drag")}
          >
            {virtualizer.getVirtualItems().map((item) => {
              const row = rows[item.index];
              return (
                <div key={item.key} className="vrow" data-index={item.index} ref={virtualizer.measureElement} style={{ transform: `translateY(${item.start}px)` }}>
                  <RowView
                    row={row}
                    tokens={tokens}
                    focused={isFocused(row, focusHunk)}
                    sel={selected(row, selection, selCount)}
                    found={findIn(row, hits, currentHit?.path === file.path ? currentHit : null)}
                    actions={actions}
                    blinking={!!blink && "hunk" in row && row.hunk === blink.hunk}
                    onExpand={onExpand}
                    onFocusHunk={onFocusHunk}
                    onAct={onAct}
                    onBlink={onBlink}
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

// Search hits for a row's A side (or its unified line) and B side, plus where the current hit starts.
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

// Hunk rows get their selected-line count; line rows a bitmask, 1 for A (or the unified line) and 2 for B.
function selected(row: Row, selection: ReadonlySet<string>, counts: Map<number, number>): number {
  if (row.t === "hunk") return counts.get(row.hunk) ?? 0;
  if (!selection.size || (row.t !== "split" && row.t !== "uni")) return 0;
  const has = (side?: Side) => !!side?.sel && selection.has(side.sel);
  return row.t === "split" ? (has(row.a) ? 1 : 0) | (has(row.b) ? 2 : 0) : has(row.line) ? 1 : 0;
}

function PaneHead({ tag, name, side, children }: { tag: "a" | "b"; name: string; side: SideInfo; children?: React.ReactNode }) {
  return (
    <div className="pane-h">
      <span className={`plate-tag tag-${tag}`}>{tag.toUpperCase()}</span>
      {name ? <b>{name.split("/").pop()}</b> : <b>—</b>}
      <span>{name ? `${side.label}, ${name}` : `${side.label}, not present`}</span>
      {children}
    </div>
  );
}

interface RowProps {
  row: Row;
  tokens: [TokLines | null, TokLines | null] | null;
  focused: boolean;
  sel: number;
  found: Found;
  actions: "unstaged" | "staged" | null;
  // the row belongs to the blinking hunk
  blinking: boolean;
  onExpand(key: string): void;
  onFocusHunk(hunk: number): void;
  onAct(action: StageAction, target: number | "file"): void;
  onBlink(hunk: number): void;
}

const BREAK_LINE = (
  <svg viewBox="0 0 20 22" aria-hidden="true">
    <path d="M0 11h6l2.5-7 3 14 2.5-7h6" />
  </svg>
);

const RowView = memo(function RowView({ row, tokens, focused, sel, found, actions, blinking, onExpand, onFocusHunk, onAct, onBlink }: RowProps) {
  switch (row.t) {
    case "hunk": {
      const lines = sel ? ` ${sel} ${sel === 1 ? "line" : "lines"}` : "";
      const button = (action: StageAction, label: string, key: string) => (
        <button
          className={`hh-btn hh-${action}`}
          onClick={(e) => {
            e.stopPropagation();
            onAct(action, row.hunk);
          }}
        >
          {label}
          {lines}
          <kbd>{key}</kbd>
        </button>
      );
      return (
        <div className={`hunk-head${focused ? " is-focus" : ""}${sel ? " has-sel" : ""}`} onClick={() => onFocusHunk(row.hunk)}>
          <span className="hh-range">{row.label}</span>
          <span className="hh-ctx">{row.ctx}</span>
          <span className="hh-stat">
            <span className="s-add">+{row.adds}</span> <span className="s-del">−{row.dels}</span>
          </span>
          {row.staged && <span className="hh-badge">{row.staged === "full" ? "Staged" : "Partly staged"}</span>}
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
              onClick={(e) => {
                e.stopPropagation();
                onBlink(row.hunk);
              }}
            >
              {blinking ? "Stop blink" : "Blink"}
              <kbd>{blinking ? "esc" : "shift b"}</kbd>
            </button>
            {actions && (actions === "staged" ? button("unstage", "Unstage", "s") : button("stage", "Stage", "s"))}
            {actions === "unstaged" && button("discard", "Discard", "x")}
          </span>
        </div>
      );
    }
    case "fold":
      return (
        <button className="fold" disabled={!row.expandable} onClick={() => onExpand(row.key)}>
          {BREAK_LINE}
          <span>{row.label ?? `${row.count} ${row.count === 1 ? "line" : "lines"} unchanged`}</span>
        </button>
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
        <div className={`row split${row.faded ? " is-staged" : ""}`}>
          <SplitCell side="a" line={row.a} kind={row.kind} tokens={tokens?.[0]} sel={!!(sel & 1)} hits={found.a} current={found.curA} />
          <SplitCell side="b" line={row.b} kind={row.kind} tokens={tokens?.[1]} sel={!!(sel & 2)} hits={found.b} current={found.curB} />
        </div>
      );
    case "uni": {
      const cls = `${row.kind === "ctx" ? "" : row.kind}${sel ? " sel" : ""}${row.line.staged ? " is-staged" : ""}`;
      const toks = row.kind === "del" ? tokens?.[0] : tokens?.[1];
      const line = row.line.sel ? { "data-line": row.line.sel, "data-col": "u" } : {};
      return (
        <div className={`row uni${row.faded ? " is-staged" : ""}`}>
          <div className={`ln a ${cls}`} {...line}>
            {row.a ?? ""}
          </div>
          <div className={`ln b ${cls}`} {...line}>
            {row.b ?? ""}
          </div>
          <div className={`cell ${cls}`} style={hangingIndent(row.line.text)}>
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
        <Code text={line.text} tokens={tokens?.[line.no - 1]} words={line.words} mark={side === "a" ? "w-del" : "w-add"} hits={hits} current={current} />
      </div>
    </>
  );
}

// One plate's line in a blinking hunk. Both plates share the row so it keeps its height and only changes move.
function PlateSide({ side, line, kind, tokens, hits, current }: Omit<CellProps, "sel">) {
  if (!line) return <div className={`p${side}`} />;
  const cls = kind === "ctx" ? "" : side === "a" ? "del" : "add";
  return (
    <div className={`p${side}`}>
      <div className={`ln ${cls}`}>{line.no}</div>
      <div className={`cell ${cls}`} style={hangingIndent(line.text)}>
        <Code text={line.text} tokens={tokens?.[line.no - 1]} words={line.words} mark={side === "a" ? "w-del" : "w-add"} hits={hits} current={current} />
      </div>
    </div>
  );
}
