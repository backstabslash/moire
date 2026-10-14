import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CompareMode, FileDiff, SideInfo } from "../../../shared/types";
import { renderMarkdown } from "../model/markdown";
import { blobUrl, changeMarks, resolveRelative, sidePaths } from "../model/preview";
import type { Row } from "../model/rows";
import type { DiffViewHandle } from "./DiffView";

interface ImageProps {
  root: string;
  mode: CompareMode;
  file: FileDiff;
  a: SideInfo;
  b: SideInfo;
  version: string;
}

export function ImagePreview({ root, mode, file, a, b, version }: ImageProps) {
  const [sizes, setSizes] = useState<[number | null, number | null] | null>(null);
  useEffect(() => {
    let stale = false;
    window.moire
      .blobSizes(root, mode, file)
      .then((s) => !stale && setSizes(s))
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [root, version]);
  const [pathA, pathB] = sidePaths(file);
  const urlA = pathA && blobUrl(root, a, pathA, version);
  const urlB = pathB && blobUrl(root, b, pathB, version);
  return (
    <div className="img-compare">
      <ImageSide key={urlA ?? "a"} side="a" url={urlA} bytes={sizes?.[0] ?? null} />
      <ImageSide key={urlB ?? "b"} side="b" url={urlB} bytes={sizes?.[1] ?? null} />
    </div>
  );
}

function ImageSide({ side, url, bytes }: { side: "a" | "b"; url: string | null; bytes: number | null }) {
  const [dims, setDims] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  if (!url) return <figure className={`img-side ${side} is-absent`}>Not present</figure>;
  return (
    <figure className={`img-side ${side}`}>
      <div className="img-frame">
        {failed ? (
          <span className="img-failed">Can't show this image</span>
        ) : (
          <img src={url} alt="" onLoad={(e) => setDims(`${e.currentTarget.naturalWidth} × ${e.currentTarget.naturalHeight}`)} onError={() => setFailed(true)} />
        )}
      </div>
      <figcaption>{[dims, bytes !== null && formatBytes(bytes)].filter(Boolean).join(", ")}</figcaption>
    </figure>
  );
}

function hunksOf(el: HTMLElement): number[] {
  return el.dataset.hunks ? el.dataset.hunks.split(" ").map(Number) : [];
}

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

interface MarkdownProps {
  root: string;
  file: FileDiff;
  rows: Row[];
  // the side being shown, B unless the file was deleted
  side: SideInfo;
  text: string | null;
  version: string;
  focusHunk: number;
  onFocusHunk(hunk: number): void;
}

interface Bar {
  kind: "chg" | "cut";
  top: number;
  height: number;
  hunks: number[];
}

const CUT_GAP = 6;

// The file rendered, with a bar beside each block the diff touched. A new or deleted file has no bars.
export const MarkdownPreview = forwardRef<DiffViewHandle, MarkdownProps>(function MarkdownPreview(props, ref) {
  const { root, file, rows, side, text, version, focusHunk, onFocusHunk } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const articleRef = useRef<HTMLElement>(null);
  const [bars, setBars] = useState<Bar[]>([]);
  const path = file.status === "deleted" ? (file.oldPath ?? file.path) : file.path;
  const whole = file.status === "added" || file.status === "untracked" || file.status === "deleted";
  const html = useMemo(() => {
    if (text === null) return "";
    return renderMarkdown(text, whole ? null : changeMarks(file), (src) => {
      const target = resolveRelative(path, src);
      return target && blobUrl(root, side, target, version);
    });
  }, [text, file, root, side.kind, side.rev, version]);

  // Bars sit in one gutter, measured from the blocks, so nested lists and quotes don't push them into the text.
  useLayoutEffect(() => {
    const article = articleRef.current;
    if (!article) return;
    const measure = () => {
      const base = article.getBoundingClientRect().top;
      const next: Bar[] = [];
      for (const el of article.querySelectorAll<HTMLElement>(".md-chg, .md-cut, .md-cut-end")) {
        const r = el.getBoundingClientRect();
        const top = r.top - base;
        const hunks = hunksOf(el);
        if (el.classList.contains("md-chg")) next.push({ kind: "chg", top, height: r.height, hunks });
        if (el.classList.contains("md-cut")) next.push({ kind: "cut", top: top - CUT_GAP, height: 0, hunks });
        if (el.classList.contains("md-cut-end")) next.push({ kind: "cut", top: top + r.height + CUT_GAP, height: 0, hunks });
      }
      setBars(next);
    };
    measure();
    const resize = new ResizeObserver(measure);
    resize.observe(article);
    return () => resize.disconnect();
  }, [html]);

  useImperativeHandle(ref, () => ({
    scrollToRow(index, align = "start") {
      const box = scrollRef.current;
      const row = rows[index];
      if (!box || !row) return;
      let el = row.t === "hunk" ? box.querySelector(`[data-hunks~="${row.hunk}"]`) : null;
      if (!el) {
        const line = row.t === "hunk" ? file.hunks[row.hunk]?.newStart : row.t === "split" ? (row.b?.no ?? row.a?.no) : row.t === "uni" ? (row.b ?? row.a) : undefined;
        if (line === undefined) return;
        el = [...box.querySelectorAll<HTMLElement>("[data-from]")].find((e) => Number(e.dataset.to) >= line) ?? null;
      }
      if (!el) return;
      const top = el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
      box.scrollTo({ top: Math.max(0, align === "center" ? top - box.clientHeight / 2 : top - 40) });
    },
    scroller: () => scrollRef.current,
  }));

  const click = (e: React.MouseEvent) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-hunks]");
    const hunks = el ? hunksOf(el) : [];
    if (hunks.length && !hunks.includes(focusHunk)) onFocusHunk(hunks[0]);
  };

  return (
    <div className="scroller md-scroller" ref={scrollRef}>
      <div className="md-page">
        {bars.map((bar, i) => (
          <i key={i} className={`md-bar ${bar.kind}${bar.hunks.includes(focusHunk) ? " is-focus" : ""}`} style={{ top: bar.top, height: bar.height || undefined }} />
        ))}
        <article className="md" ref={articleRef} onClick={click} dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    </div>
  );
});
