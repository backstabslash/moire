import { fenceLang } from "../model/lang";
import { fenceLines, paint } from "../model/redline";
import { highlight } from "./client";
import type { Tok } from "./types";

const ITALIC = 1;
const BOLD = 2;

function colourLine(line: HTMLElement, tokens: Tok[] | undefined) {
  let at = 0;
  const ops = (tokens ?? []).map(([text, color, fontStyle]) => {
    const start = at;
    at += text.length;
    const wrap = () => {
      const span = document.createElement("span");
      span.style.color = color;
      if (fontStyle & ITALIC) span.style.fontStyle = "italic";
      if (fontStyle & BOLD) span.style.fontWeight = "600";
      return span;
    };
    return { start, end: at, wrap };
  });
  paint(line, ops);
}

export async function colourFences(root: HTMLElement, signal: AbortSignal) {
  for (const code of root.querySelectorAll<HTMLElement>("code[data-lang]")) {
    const lang = fenceLang(code.dataset.lang!);
    if (lang === "text" || code.dataset.lang === "mermaid") continue;
    const lines = fenceLines(code);
    const text = (skip: string) =>
      lines
        .filter((l) => !l.classList.contains(skip))
        .map((l) => l.textContent)
        .join("\n");
    const sides = await highlight(lang, text("add"), text("del"), { background: true, signal });
    if (!sides || signal.aborted) return;
    let a = 0;
    let b = 0;
    for (const line of lines) {
      const del = line.classList.contains("del");
      if (!line.classList.contains("add")) a++;
      if (!del) b++;
      colourLine(line, del ? sides[0]?.[a - 1] : sides[1]?.[b - 1]);
    }
  }
}
