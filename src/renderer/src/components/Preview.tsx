import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { BlobSize, CompareMode, FileDiff, SideInfo } from "../../../shared/types";
import { renderMarkdown } from "../model/markdown";
import { blobUrl, changeMarks, resolveRelative, sidePaths } from "../model/preview";
import type { Row } from "../model/rows";
import type { Find } from "../model/search";
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
  const [sizes, setSizes] = useState<[BlobSize | null, BlobSize | null] | null>(null);
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
    <div className={`img-compare${file.status === "unchanged" ? " is-whole" : ""}`}>
      {file.status !== "unchanged" && <ImageSide key={urlA ?? "a"} side="a" url={urlA} size={sizes?.[0] ?? null} />}
      <ImageSide key={urlB ?? "b"} side="b" url={urlB} size={sizes?.[1] ?? null} />
    </div>
  );
}

function ImageSide({ side, url, size }: { side: "a" | "b"; url: string | null; size: BlobSize | null }) {
  const [dims, setDims] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  if (!url) return <figure className={`img-side ${side} is-absent`}>Not present</figure>;
  return (
    <figure className={`img-side ${side}`}>
      <div className="img-frame">
        {failed ? (
          <span className="img-failed">{size?.lfsMissing ? "Stored in Git LFS and not downloaded. git lfs pull fetches it." : "Can't show this image"}</span>
        ) : (
          <img src={url} alt="" onLoad={(e) => setDims(`${e.currentTarget.naturalWidth} × ${e.currentTarget.naturalHeight}`)} onError={() => setFailed(true)} />
        )}
      </div>
      <figcaption>{[dims, size && formatBytes(size.bytes)].filter(Boolean).join(", ")}</figcaption>
    </figure>
  );
}

function hunksOf(el: HTMLElement): number[] {
  return el.dataset.hunks ? el.dataset.hunks.split(" ").map(Number) : [];
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

interface MarkdownProps {
  root: string;
  file: FileDiff;
  rows: Row[];
  side: SideInfo;
  text: string | null;
  version: string;
  focusHunk: number;
  find: Find | null;
  onFocusHunk(hunk: number): void;
}

interface Bar {
  kind: "chg" | "cut";
  top: number;
  height: number;
  hunks: number[];
}

const CUT_GAP = 6;

export const MarkdownPreview = forwardRef<DiffViewHandle, MarkdownProps>(function MarkdownPreview(props, ref) {
  const { root, file, rows, side, text, version, focusHunk, find, onFocusHunk } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const articleRef = useRef<HTMLElement>(null);
  const [bars, setBars] = useState<Bar[]>([]);
  const path = file.status === "deleted" ? (file.oldPath ?? file.path) : file.path;
  const whole = file.status === "added" || file.status === "untracked" || file.status === "deleted" || file.status === "unchanged";
  const html = useMemo(() => {
    if (text === null) return "";
    return renderMarkdown(text, whole ? null : changeMarks(file), (src) => {
      const target = resolveRelative(path, src);
      return target && blobUrl(root, side, target, version);
    });
  }, [text, file, root, side.kind, side.rev, version]);

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
        // A change that renders nothing, like an emptied comment, still gets a tick where it sits.
        if (el.classList.contains("md-chg")) next.push(r.height ? { kind: "chg", top, height: r.height, hunks } : { kind: "cut", top, height: 0, hunks });
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

  const revealed = useRef("");
  useEffect(() => {
    const article = articleRef.current;
    if (!article || !find) return;
    const ranges: Range[] = [];
    const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      for (const m of node.textContent!.matchAll(new RegExp(find.pattern.source, find.pattern.flags))) {
        if (!m[0]) continue;
        const range = new Range();
        range.setStart(node, m.index);
        range.setEnd(node, m.index + m[0].length);
        ranges.push(range);
      }
    }
    const current = ranges[Math.min(find.index, ranges.length - 1)];
    CSS.highlights.set("moire-hit", new Highlight(...ranges));
    if (current) CSS.highlights.set("moire-hit-now", new Highlight(current));
    const reveal = `${find.tick} ${find.pattern}`;
    const frame = requestAnimationFrame(() => {
      const box = scrollRef.current;
      if (!box || !current || revealed.current === reveal) return;
      revealed.current = reveal;
      const top = current.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
      box.scrollTo({ top: Math.max(0, top - box.clientHeight / 2) });
    });
    return () => {
      cancelAnimationFrame(frame);
      CSS.highlights.delete("moire-hit");
      CSS.highlights.delete("moire-hit-now");
    };
  }, [html, find]);

  useImperativeHandle(ref, () => ({
    scrollToRow(index, align = "start") {
      const box = scrollRef.current;
      const row = rows[index];
      if (!box || !row) return;
      let el = row.t === "hunk" ? box.querySelector(`[data-hunks~="${row.hunk}"]`) : null;
      if (!el) {
        const line =
          row.t === "hunk" ? file.hunks[row.hunk]?.newStart : row.t === "split" ? (row.b?.no ?? row.a?.no) : row.t === "uni" ? (row.b ?? row.a) : undefined;
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
          <i
            key={i}
            className={`md-bar ${bar.kind}${bar.hunks.includes(focusHunk) ? " is-focus" : ""}`}
            style={{ top: bar.top, height: bar.height || undefined }}
          />
        ))}
        <article className="md" ref={articleRef} onClick={click} dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    </div>
  );
});
