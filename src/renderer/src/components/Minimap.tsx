import { type RefObject, useEffect, useRef } from "react";
import type { Row } from "../model/rows";
import type { Range } from "../model/words";

const MAX_ROW_PX = 3;

interface Mark {
  a: "ctx" | "chg" | null;
  b: "ctx" | "chg" | null;
  aText: string;
  bText: string;
  sep: boolean;
  hit: boolean;
  faded: boolean;
}

function marksFor(rows: Row[], hits: ReadonlyMap<string, Range[]> | null): Mark[] {
  const found = (...keys: (string | undefined)[]) => !!hits && keys.some((k) => k && hits.has(k));
  return rows.map((r): Mark => {
    if (r.t === "split") {
      return { a: r.a ? r.kind : null, b: r.b ? r.kind : null, aText: r.a?.text ?? "", bText: r.b?.text ?? "", sep: false, hit: found(r.a?.sel, r.b?.sel), faded: !!(r.faded || r.a?.staged || r.b?.staged) };
    }
    if (r.t === "uni") {
      const ctx = r.kind === "ctx";
      const a = ctx ? "ctx" : r.kind === "del" ? "chg" : null;
      const b = ctx ? "ctx" : r.kind === "add" ? "chg" : null;
      return { a, b, aText: r.line.text, bText: r.line.text, sep: false, hit: found(r.line.sel), faded: !!(r.faded || r.line.staged) };
    }
    return { a: null, b: null, aText: "", bText: "", sep: true, hit: false, faded: false };
  });
}

interface Props {
  rows: Row[];
  hits: ReadonlyMap<string, Range[]> | null;
  scrollRef: RefObject<HTMLDivElement | null>;
}

export function Minimap({ rows, hits, scrollRef }: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const box = boxRef.current;
    const canvas = canvasRef.current;
    const scroller = scrollRef.current;
    if (!box || !canvas || !scroller) return;
    const marks = marksFor(rows, hits);
    let frame = 0;

    const paintImage = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = box.clientWidth;
      const h = box.clientHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      const image = document.createElement("canvas");
      image.width = canvas.width;
      image.height = canvas.height;
      const ctx = image.getContext("2d")!;
      ctx.scale(dpr, dpr);
      const css = getComputedStyle(document.documentElement);
      const v = (name: string) => css.getPropertyValue(name).trim();
      const rowPx = Math.min(MAX_ROW_PX, h / Math.max(1, marks.length));
      const barH = Math.max(0.6, rowPx * 0.6);
      const half = w / 2;
      ctx.fillStyle = v("--rule");
      ctx.fillRect(half - 0.3, 0, 0.6, marks.length * rowPx);
      marks.forEach((m, i) => {
        const y = i * rowPx;
        if (m.sep) return;
        // search hits tick both edges, so they never cover a change
        if (m.hit) {
          ctx.fillStyle = v("--hit-now");
          ctx.fillRect(0, y - 0.5, 3, Math.max(2, rowPx));
          ctx.fillRect(w - 3, y - 0.5, 3, Math.max(2, rowPx));
        }
        ctx.globalAlpha = m.faded ? 0.45 : 1;
        bar(ctx, m.a, m.aText, 4, y, barH, v("--a"), v("--faint"));
        bar(ctx, m.b, m.bText, half + 4, y, barH, v("--b"), v("--faint"));
        ctx.globalAlpha = 1;
      });
      imageRef.current = image;
      return marks.length * rowPx;
    };

    let drawnHeight = paintImage();

    const draw = () => {
      frame = 0;
      const ctx = canvas.getContext("2d")!;
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const image = imageRef.current;
      if (!image || !image.width || !image.height) return;
      ctx.drawImage(image, 0, 0);
      const { scrollTop, scrollHeight, clientHeight } = scroller;
      if (scrollHeight <= 0) return;
      const top = (scrollTop / scrollHeight) * drawnHeight;
      const height = Math.max(6, (clientHeight / scrollHeight) * drawnHeight);
      ctx.scale(dpr, dpr);
      ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue("--ink").trim();
      ctx.lineWidth = 1;
      ctx.strokeRect(0.5, top + 0.5, box.clientWidth - 1, Math.min(height, box.clientHeight - top) - 1);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(draw);
    };

    const resize = new ResizeObserver(() => {
      drawnHeight = paintImage();
      schedule();
    });
    resize.observe(box);
    scroller.addEventListener("scroll", schedule, { passive: true });
    const themeWatch = new MutationObserver(() => {
      drawnHeight = paintImage();
      schedule();
    });
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-cvd"] });

    const seek = (event: PointerEvent) => {
      const rect = box.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (event.clientY - rect.top) / Math.max(1, drawnHeight)));
      scroller.scrollTop = ratio * scroller.scrollHeight - scroller.clientHeight / 2;
    };
    const down = (event: PointerEvent) => {
      box.setPointerCapture(event.pointerId);
      seek(event);
      box.addEventListener("pointermove", seek);
    };
    const up = () => box.removeEventListener("pointermove", seek);
    box.addEventListener("pointerdown", down);
    box.addEventListener("pointerup", up);
    schedule();

    return () => {
      if (frame) cancelAnimationFrame(frame);
      resize.disconnect();
      themeWatch.disconnect();
      scroller.removeEventListener("scroll", schedule);
      box.removeEventListener("pointerdown", down);
      box.removeEventListener("pointerup", up);
      box.removeEventListener("pointermove", seek);
    };
  }, [rows, hits, scrollRef]);

  return (
    <div className="minimap" ref={boxRef} aria-hidden="true">
      <canvas ref={canvasRef} />
    </div>
  );
}

function bar(ctx: CanvasRenderingContext2D, kind: "ctx" | "chg" | null, text: string, x0: number, y: number, h: number, changed: string, faint: string) {
  if (!kind || !text.trim()) return;
  const indent = text.search(/\S/);
  const width = Math.min(28, (text.length - indent) * 0.5);
  const alpha = ctx.globalAlpha;
  ctx.globalAlpha = alpha * (kind === "ctx" ? 0.35 : 1);
  ctx.fillStyle = kind === "chg" ? changed : faint;
  ctx.fillRect(x0 + indent * 0.6, y, width, h);
  ctx.globalAlpha = alpha;
}
