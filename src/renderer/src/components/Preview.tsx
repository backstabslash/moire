import { forwardRef, type RefObject, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { BlobSize, CompareMode, FileDiff, SideInfo } from "../../../shared/types";
import { drawDiagrams } from "../diagrams";
import { colourFences } from "../highlight/fences";
import { markdownPage, plainPage } from "../model/markdown";
import { blobUrl, changeMarks, hasTwoVersions, type PreviewView, readOnly, resolveRelative, sidePaths, tooBigToRender } from "../model/preview";
import { fenceSource, markChanges, oldCuts, showHiddenText } from "../model/redline";
import type { Row } from "../model/rows";
import type { Find } from "../model/search";
import type { DiffViewHandle } from "./DiffView";
import { Enlarged } from "./Screenshots";

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
  oldSide: SideInfo;
  text: string | null;
  old: string | null;
  view: PreviewView;
  version: string;
  focusHunk: number;
  step: { from: number; to: number; no: number }[];
  find: Find | null;
  spot: RefObject<ReadSpot | null>;
  onFocusHunk(hunk: number): void;
  onOpenFile(path: string): void;
}

export interface ReadSpot {
  path: string;
  line: number;
  offset: number;
}

interface Bar {
  kind: "chg" | "cut";
  top: number;
  height: number;
  hunks: number[];
}

interface Rail {
  no: number;
  top: number;
  left: number;
  height: number;
}

const DISC = 18;
const RAIL_MIN = 9;
// The gap each view leaves beside the text: clear of the change bars in Changes, inside the column in Side by side.
const RAIL_FROM_TEXT = { changes: -45, sides: 9, read: -24 };

const railBlock = (el: HTMLElement) => el.closest<HTMLElement>(".md-fence, table") ?? el;

interface Heading {
  el: HTMLElement;
  level: number;
  text: string;
  chg: boolean;
  cut: boolean;
}

const CUT_GAP = 6;
const MIN_OUTLINE = 2;
const HOLD_MS = 1000;
// A heading this far below the top still counts as the section being read.
const HEADING_SLACK = 64;

function headingsOf(article: HTMLElement, marked: boolean): Heading[] {
  const out: Heading[] = [];
  for (const el of article.querySelectorAll<HTMLElement>("h1, h2, h3, .md-chg, .md-gone, .md-cut, .md-cut-end, .md-del")) {
    if (/^H[123]$/.test(el.tagName) && !el.classList.contains("md-gone")) {
      out.push({ el, level: Number(el.tagName[1]), text: el.textContent, chg: false, cut: false });
    }
    const last = out.at(-1);
    if (!last || !marked) continue;
    if (el.classList.contains("md-chg") && !el.classList.contains("md-del")) last.chg = true;
    if (el.matches(".md-gone, .md-cut, .md-cut-end, .md-del")) last.cut = true;
  }
  return out;
}

// A subheading before any heading above it has no parent to sit under, so it starts at the left.
function outlineDepths(headings: Heading[]) {
  let top = Infinity;
  return headings.map((heading) => {
    top = Math.min(top, heading.level);
    return { heading, depth: heading.level - top };
  });
}

function gapTarget(el: HTMLElement, article: HTMLElement): HTMLElement | null {
  if (el.tagName === "TR") return el.parentElement!.parentElement!.querySelector("tr") === el ? el.closest("table") : null;
  let at = el.closest<HTMLElement>(".md-fence") ?? el;
  while (at.parentElement && at.parentElement !== article && at.parentElement.firstElementChild === at) at = at.parentElement;
  return at;
}

function addGap(before: HTMLElement, height: number, hole: boolean) {
  const gap = document.createElement("i");
  gap.className = hole ? "md-gap is-hole" : "md-gap";
  gap.style.height = `${height}px`;
  before.before(gap);
  return gap;
}

// Reads and writes alternate, but only blocks that have drifted write, so a long doc stays cheap.
function lineUp(a: HTMLElement, b: HTMLElement) {
  for (const gap of [...a.querySelectorAll(".md-gap"), ...b.querySelectorAll(".md-gap")]) gap.remove();
  const leavesB = [...b.querySelectorAll<HTMLElement>("[data-from]")];
  const topOf = (el: HTMLElement) => el.getBoundingClientRect().top;
  let at = 0;
  let loneA = false;
  for (const x of a.querySelectorAll<HTMLElement>("[data-from]")) {
    if (x.dataset.pair === undefined) {
      loneA = true;
      continue;
    }
    let loneB = false;
    while (at < leavesB.length && leavesB[at].dataset.pair !== x.dataset.pair) {
      loneB = true;
      at++;
    }
    const y = leavesB[at++];
    const boxA = gapTarget(x, a);
    const boxB = y && gapTarget(y, b);
    if (boxA && boxB && boxA.getClientRects().length && boxB.getClientRects().length) {
      const drift = topOf(boxA) - topOf(boxB);
      if (Math.abs(drift) >= 0.5) {
        const [low, high] = drift > 0 ? [boxB, boxA] : [boxA, boxB];
        const gap = addGap(low, Math.abs(drift), drift > 0 ? loneA : loneB);
        // A gap stops the margins around it collapsing, which pushes the block further than the gap's height.
        const short = topOf(high) - topOf(low);
        if (short > 0) gap.style.height = `${Math.abs(drift) + short}px`;
        else gap.style.marginBottom = `${short}px`;
      }
    }
    loneA = false;
  }
}

function partnerOf(box: HTMLElement, page: HTMLElement): HTMLElement | null {
  const pair = (box.matches("[data-pair]") ? box : box.querySelector<HTMLElement>("[data-pair]"))?.dataset.pair;
  if (pair === undefined) return null;
  for (const el of page.querySelectorAll(`[data-pair="${pair}"]`)) {
    if (!box.contains(el)) return el.closest<HTMLElement>("table, pre");
  }
  return null;
}

function firstBelow(els: HTMLElement[], top: number): number {
  let lo = 0;
  let hi = els.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (els[mid].getBoundingClientRect().bottom > top) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

function textRuns(root: HTMLElement): Text[][] {
  const runs: Text[][] = [];
  let owner: Element | null = null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const parent = node.parentElement!;
    if (parent.closest(".md-tools")) continue;
    const leaf = parent.closest("[data-from], .md-gone");
    if (!leaf || leaf !== owner) runs.push([]);
    owner = leaf;
    runs[runs.length - 1].push(node);
  }
  return runs;
}

function rangeIn(run: Text[], start: number, end: number): Range {
  const range = new Range();
  let pos = 0;
  for (const node of run) {
    if (pos <= start && start < pos + node.length) range.setStart(node, start - pos);
    if (pos < end && end <= pos + node.length) range.setEnd(node, end - pos);
    pos += node.length;
  }
  return range;
}

export const MarkdownPreview = forwardRef<DiffViewHandle, MarkdownProps>(function MarkdownPreview(props, ref) {
  const { root, file, rows, side, oldSide, text, old, version, focusHunk, step, find, spot, onFocusHunk, onOpenFile } = props;
  const scrollRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const articleRef = useRef<HTMLElement>(null);
  const oldRef = useRef<HTMLElement>(null);
  const outlineRef = useRef<HTMLElement>(null);
  const holdUntil = useRef(0);
  const trackFrame = useRef(0);
  const pickedHeading = useRef<{ index: number; top: number } | null>(null);
  const [here, setHere] = useState(0);
  const [enlarged, setEnlarged] = useState<string | null>(null);
  const [bars, setBars] = useState<Bar[]>([]);
  const [rails, setRails] = useState<Rail[]>([]);
  const stepBlocks = useRef<{ els: HTMLElement[]; no: number }[]>([]);
  const [headings, setHeadings] = useState<Heading[]>([]);
  const headingsRef = useRef<Heading[]>([]);
  const path = file.status === "deleted" ? (file.oldPath ?? file.path) : file.path;
  const oldPath = file.oldPath ?? file.path;
  const whole = !hasTwoVersions(file, old);
  const tooBig = tooBigToRender(text) || tooBigToRender(old);
  const view = readOnly(file, text, old) ? "read" : props.view;
  const { html, oldHtml } = useMemo(() => {
    if (text === null) return { html: "", oldHtml: "" };
    if (tooBig) return { html: plainPage(text), oldHtml: "" };
    const images = (from: string, at: SideInfo) => (src: string) => {
      const target = resolveRelative(from, src);
      return target && blobUrl(root, at, target, version);
    };
    const marks = whole ? null : changeMarks(file);
    const page = markdownPage(text, marks, images(path, side));
    if (file.status === "added" || file.status === "untracked") showHiddenText(page, text);
    if (view === "read" || old === null) return { html: page.innerHTML, oldHtml: "" };
    const before = markdownPage(old, null, images(oldPath, oldSide));
    markChanges(before, page, old, text, oldCuts(file), marks?.added ?? new Map(), view === "changes");
    return { html: page.innerHTML, oldHtml: view === "sides" ? before.innerHTML : "" };
  }, [text, old, view, file, root, side.kind, side.rev, oldSide.kind, oldSide.rev, version]);

  const measure = useCallback(() => {
    const article = articleRef.current;
    if (!article) return;
    if (view !== "changes") return setBars([]);
    const base = article.getBoundingClientRect().top;
    const next: Bar[] = [];
    for (const el of article.querySelectorAll<HTMLElement>(".md-chg, .md-cut, .md-cut-end, .md-gone")) {
      const r = el.getBoundingClientRect();
      const top = r.top - base;
      const hunks = hunksOf(el);
      // An image for the other theme has no height here, but its change still gets a tick where it sits.
      if (el.classList.contains("md-chg")) next.push(r.height ? { kind: "chg", top, height: r.height, hunks } : { kind: "cut", top, height: 0, hunks });
      if (el.classList.contains("md-gone")) next.push({ kind: "cut", top: top + r.height / 2, height: 0, hunks });
      if (el.classList.contains("md-cut")) next.push({ kind: "cut", top: top - CUT_GAP, height: 0, hunks });
      if (el.classList.contains("md-cut-end")) next.push({ kind: "cut", top: top + r.height + CUT_GAP, height: 0, hunks });
    }
    setBars(next);
  }, [view]);

  const placeRails = useCallback(() => {
    const article = articleRef.current;
    const page = pageRef.current;
    if (!article || !page) return;
    const box = page.getBoundingClientRect();
    const left = Math.max(RAIL_MIN, article.getBoundingClientRect().left - box.left + RAIL_FROM_TEXT[view]);
    const next = stepBlocks.current.map(({ els, no }) => {
      const first = railBlock(els[0]).getBoundingClientRect();
      const end = railBlock(els[els.length - 1]).getBoundingClientRect().bottom;
      const line = parseFloat(getComputedStyle(els[0]).lineHeight) || DISC;
      const top = first.top - box.top + (Math.min(line, first.height) - DISC) / 2;
      return { no, top, left, height: Math.max(DISC, end - box.top - top) };
    });
    setRails(next);
  }, [view]);

  const leaves = useCallback(() => [...(articleRef.current?.querySelectorAll<HTMLElement>("[data-from]") ?? [])], []);

  const track = useCallback(() => {
    const box = scrollRef.current;
    if (!box) return;
    const top = box.getBoundingClientRect().top;
    const all = leaves();
    const leaf = all[firstBelow(all, top)];
    if (leaf && performance.now() >= holdUntil.current)
      spot.current = { path, line: Number(leaf.dataset.from), offset: leaf.getBoundingClientRect().top - top };
    const picked = pickedHeading.current;
    if (picked && Math.abs(box.scrollTop - picked.top) < 2) return setHere(picked.index);
    pickedHeading.current = null;
    const marks = headingsRef.current.map((h) => h.el);
    const atEnd = box.scrollTop + box.clientHeight >= box.scrollHeight - 2;
    setHere(atEnd ? marks.length - 1 : Math.max(0, firstBelow(marks, top + HEADING_SLACK) - 1));
  }, [path, leaves, spot]);

  const restoreSpot = useCallback(() => {
    const box = scrollRef.current;
    const at = spot.current;
    if (!box || at?.path !== path) return;
    const leaf = leaves().find((el) => Number(el.dataset.from) >= at.line);
    if (leaf) box.scrollTop += leaf.getBoundingClientRect().top - box.getBoundingClientRect().top - at.offset;
  }, [path, leaves, spot]);

  useLayoutEffect(() => {
    const article = articleRef.current;
    if (!article) return;
    const old = view === "sides" ? oldRef.current : null;
    const settle = () => {
      if (old) lineUp(old, article);
      measure();
      placeRails();
      if (performance.now() < holdUntil.current) restoreSpot();
    };
    holdUntil.current = spot.current?.path === path ? performance.now() + HOLD_MS : 0;
    settle();
    const found = headingsOf(article, view === "changes");
    headingsRef.current = found;
    setHeadings(found);
    // Fonts, images and diagrams all move blocks late. Waiting a frame stops the realign from re-firing this observer.
    let frame = 0;
    const resize = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(settle);
    });
    resize.observe(article);
    if (old) resize.observe(old);
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
    };
  }, [html, oldHtml, view, measure, placeRails, restoreSpot, path, spot]);

  useEffect(() => {
    const nav = outlineRef.current;
    const button = nav?.querySelector<HTMLElement>(".is-here");
    if (!nav || !button) return;
    const above = button.offsetTop - nav.scrollTop;
    if (above < 0) nav.scrollTop += above;
    else if (above + button.offsetHeight > nav.clientHeight) nav.scrollTop += above + button.offsetHeight - nav.clientHeight;
  }, [here, headings]);

  useEffect(() => {
    const page = pageRef.current;
    if (!page) return;
    const focused = [...page.querySelectorAll(`[data-hunks~="${focusHunk}"]`)];
    for (const el of focused) el.classList.add("is-focus");
    return () => {
      for (const el of focused) el.classList.remove("is-focus");
    };
  }, [html, oldHtml, view, focusHunk]);

  useEffect(() => {
    const steps: HTMLElement[] = [];
    stepBlocks.current = [];
    for (const { from, to, no } of step) {
      const inRange = leaves().filter((el) => Number(el.dataset.from) <= to && Number(el.dataset.to) >= from);
      for (const el of inRange) {
        el.classList.add("is-step");
        steps.push(el);
      }
      if (inRange.length) stepBlocks.current.push({ els: inRange, no });
    }
    placeRails();
    return () => {
      stepBlocks.current = [];
      for (const el of steps) el.classList.remove("is-step");
    };
  }, [html, oldHtml, view, step, leaves, placeRails]);

  useEffect(() => {
    const page = pageRef.current;
    if (!page) return;
    const coloured = new AbortController();
    void colourFences(page, coloured.signal);
    let drawn = new AbortController();
    const draw = () => void drawDiagrams(page, drawn.signal);
    draw();
    const theme = new MutationObserver(() => {
      drawn.abort();
      drawn = new AbortController();
      draw();
    });
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-cvd"] });
    return () => {
      theme.disconnect();
      coloured.abort();
      drawn.abort();
    };
  }, [html, oldHtml]);

  useEffect(() => {
    const page = pageRef.current;
    if (!page || view !== "sides") return;
    // The other side's own scroll event comes back here, and acting on a clamped one would drag this side with it.
    let echo: EventTarget | null = null;
    const follow = (e: Event) => {
      const box = e.target;
      if (!(box instanceof HTMLElement) || !box.matches("table, pre")) return;
      if (box === echo) {
        echo = null;
        return;
      }
      const partner = partnerOf(box, page);
      if (!partner) return;
      const was = partner.scrollLeft;
      partner.scrollLeft = box.scrollLeft;
      if (partner.scrollLeft !== was) echo = partner;
    };
    page.addEventListener("scroll", follow, true);
    return () => {
      page.removeEventListener("scroll", follow, true);
    };
  }, [view]);

  const revealed = useRef("");
  useEffect(() => {
    const page = pageRef.current;
    if (!page || !find) return;
    const ranges: Range[] = [];
    for (const run of textRuns(page)) {
      const joined = run.map((n) => n.data).join("");
      for (const m of joined.matchAll(new RegExp(find.pattern.source, find.pattern.flags))) {
        if (m[0]) ranges.push(rangeIn(run, m.index, m.index + m[0].length));
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
  }, [html, oldHtml, find]);

  const scrollTo = (el: Element, offset: number) => {
    const box = scrollRef.current;
    if (!box) return;
    const top = el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
    box.scrollTo({ top: Math.max(0, top - offset) });
  };

  useImperativeHandle(ref, () => ({
    scrollToRow(index, align = "start") {
      holdUntil.current = 0;
      const box = scrollRef.current;
      const row = rows[index];
      if (!box || !row) return;
      let el = row.t === "hunk" ? box.querySelector(`[data-hunks~="${row.hunk}"]`) : null;
      if (!el) {
        const line =
          row.t === "hunk" ? file.hunks[row.hunk]?.newStart : row.t === "split" ? (row.b?.no ?? row.a?.no) : row.t === "uni" ? (row.b ?? row.a) : undefined;
        if (line === undefined) return;
        el = [...(articleRef.current?.querySelectorAll<HTMLElement>("[data-from]") ?? [])].find((e) => Number(e.dataset.to) >= line) ?? null;
      }
      if (el) scrollTo(el, align === "center" ? box.clientHeight / 2 : 40);
    },
    scroller: () => scrollRef.current,
  }));

  const click = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target instanceof HTMLImageElement && target.classList.contains("md-diagram")) return setEnlarged(target.src);
    const copy = target.closest<HTMLElement>(".md-copy");
    if (copy) {
      const code = copy.closest(".md-fence")!.querySelector<HTMLElement>("code")!;
      void window.moire.copy(fenceSource(code)).then(() => {
        copy.textContent = "Copied";
        setTimeout(() => (copy.textContent = "Copy"), 1200);
      });
      return;
    }
    const anchor = target.closest("a");
    if (anchor) {
      e.preventDefault();
      const link = anchor.getAttribute("href");
      if (!link) return;
      if (link.startsWith("#")) {
        const spot = articleRef.current?.querySelector(`[data-anchor="${CSS.escape(decodeURIComponent(link.slice(1)))}"]`);
        if (spot) scrollTo(spot, 24);
        return;
      }
      const to = resolveRelative(path, link);
      if (to !== null) onOpenFile(to);
      else if (/^https?:/i.test(link)) window.open(link);
      return;
    }
    const el = target.closest<HTMLElement>("[data-hunks]");
    const hunks = el ? hunksOf(el) : [];
    if (hunks.length && !hunks.includes(focusHunk)) onFocusHunk(hunks[0]);
  };

  return (
    <div
      className={`scroller md-scroller is-${view}`}
      ref={scrollRef}
      onWheel={() => (holdUntil.current = 0)}
      onScroll={() => {
        cancelAnimationFrame(trackFrame.current);
        trackFrame.current = requestAnimationFrame(track);
      }}
    >
      {view === "sides" && (
        <div className="md-sides-head">
          <span className="is-a">{oldSide.label}</span>
          <span className="is-b">{side.label}</span>
        </div>
      )}
      <div className="md-layout" onClick={click}>
        <div className="md-columns">
          {view !== "sides" && headings.length >= MIN_OUTLINE && (
            <nav className="md-outline" aria-label="Outline" ref={outlineRef}>
              {outlineDepths(headings).map(({ heading: h, depth }, i) => (
                <button
                  key={i}
                  className={`level-${depth}${h.chg ? " chg" : ""}${h.cut ? " cut" : ""}${i === here ? " is-here" : ""}`}
                  aria-current={i === here ? "location" : undefined}
                  onClick={() => {
                    scrollTo(h.el, 24);
                    pickedHeading.current = { index: i, top: scrollRef.current?.scrollTop ?? 0 };
                    setHere(i);
                  }}
                >
                  {h.text}
                </button>
              ))}
            </nav>
          )}
          <div className="md-page" ref={pageRef}>
            {bars.map((bar, i) => (
              <i
                key={i}
                className={`md-bar ${bar.kind}${bar.hunks.includes(focusHunk) ? " is-focus" : ""}`}
                style={{ top: bar.top, height: bar.height || undefined }}
              />
            ))}
            {rails.map((rail, i) => (
              <i key={i} className="md-rail" data-step={rail.no} style={{ top: rail.top, left: rail.left, height: rail.height }} />
            ))}
            {view === "sides" && <article className="md is-old" ref={oldRef} dangerouslySetInnerHTML={{ __html: oldHtml }} />}
            <article className="md" ref={articleRef} dangerouslySetInnerHTML={{ __html: html }} />
          </div>
        </div>
      </div>
      {enlarged && <Enlarged src={enlarged} shot={{ file: "Diagram" }} fit onClose={() => setEnlarged(null)} />}
    </div>
  );
});
