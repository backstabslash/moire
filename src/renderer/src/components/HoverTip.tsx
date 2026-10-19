import { useEffect, useState } from "react";

const DELAY_MS = 250;

interface Tip {
  text: string;
  left: number;
  top: number;
  above: boolean;
}

export function HoverTip() {
  const [tip, setTip] = useState<Tip | null>(null);
  useEffect(() => {
    let target: HTMLElement | null = null;
    let timer = 0;
    const hide = () => {
      clearTimeout(timer);
      target = null;
      setTip(null);
    };
    const over = (e: MouseEvent) => {
      const el = (e.target as Element).closest?.<HTMLElement>("[data-tip]") ?? null;
      if (el === target) return;
      hide();
      if (!el || e.buttons) return;
      target = el;
      timer = window.setTimeout(() => {
        const box = el.getBoundingClientRect();
        const left = Math.max(8, Math.min(box.left + 8, innerWidth - 420));
        const above = box.bottom + 64 > innerHeight;
        setTip({ text: el.dataset.tip!, left, top: above ? box.top - 4 : box.bottom + 4, above });
      }, DELAY_MS);
    };
    const out = (e: MouseEvent) => !e.relatedTarget && hide();
    window.addEventListener("mouseover", over);
    window.addEventListener("mouseout", out);
    window.addEventListener("mousedown", hide);
    window.addEventListener("wheel", hide, { passive: true });
    window.addEventListener("blur", hide);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("mouseover", over);
      window.removeEventListener("mouseout", out);
      window.removeEventListener("mousedown", hide);
      window.removeEventListener("wheel", hide);
      window.removeEventListener("blur", hide);
    };
  }, []);
  if (!tip) return null;
  return (
    <div className={`hover-tip${tip.above ? " is-above" : ""}`} role="tooltip" style={{ left: tip.left, top: tip.top }}>
      {tip.text}
    </div>
  );
}
