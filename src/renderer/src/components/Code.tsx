import type { Tok } from "../highlight/types";
import type { Range } from "../model/words";

interface Piece {
  text: string;
  color?: string;
  fontStyle: number;
  hit?: number;
}

const ITALIC = 1;
const BOLD = 2;
const WRAP_HINT_MIN = 60;
const TAB_WIDTH = 4;

export function hangingIndent(text: string): React.CSSProperties | undefined {
  if (text.length <= WRAP_HINT_MIN) return undefined;
  let cols = 0;
  for (const ch of text) {
    if (ch === " ") cols++;
    else if (ch === "\t") cols += TAB_WIDTH;
    else break;
  }
  return { paddingLeft: `calc(8px + ${cols + 2}ch)`, textIndent: `-${cols + 2}ch`, "--hang": `${cols}ch` } as React.CSSProperties;
}

function renderBreakable(p: Piece, key: number) {
  const parts = p.text.split(/(?<=[.,(=/])/);
  if (parts.length === 1) return renderPiece(p, key);
  return parts.flatMap((part, i) => [i > 0 ? <wbr key={`${key}w${i}`} /> : null, renderPiece({ ...p, text: part }, key * 1000 + i)]);
}

interface CodeProps {
  text: string;
  tokens?: Tok[];
  words?: Range[];
  mark: "w-add" | "w-del";
  hits?: Range[];
  current?: number;
}

export function Code({ text, tokens, words, mark, hits, current }: CodeProps) {
  if (!text) return "​";
  const render = text.length > WRAP_HINT_MIN ? renderBreakable : renderPiece;
  let pieces: Piece[] = tokens && tokensMatch(tokens, text) ? tokens.map(([t, color, fontStyle]) => ({ text: t, color, fontStyle })) : [{ text, fontStyle: 0 }];
  if (hits?.length) pieces = splitAt(pieces, hits, (_, i) => i + 1);
  const isCurrent = (hit: number) => hits?.[hit - 1]?.[0] === current;
  if (!words?.length) return withHits(pieces, render, isCurrent);

  const out: React.ReactNode[] = [];
  let run: Piece[] = [];
  let runInside = false;
  let pos = 0;
  let w = 0;
  const flush = () => {
    if (!run.length) return;
    const rendered = withHits(run, render, isCurrent);
    out.push(
      runInside ? (
        <span key={out.length} className={mark}>
          {rendered}
        </span>
      ) : (
        rendered
      ),
    );
    run = [];
  };
  for (const piece of splitAt(pieces, words, () => undefined)) {
    while (w < words.length && words[w][1] <= pos) w++;
    const inside = w < words.length && words[w][0] <= pos;
    if (inside !== runInside) flush();
    runInside = inside;
    run.push(piece);
    pos += piece.text.length;
  }
  flush();
  return out;
}

function splitAt(pieces: Piece[], ranges: Range[], hit: (r: Range, i: number) => number | undefined): Piece[] {
  const out: Piece[] = [];
  let pos = 0;
  let r = 0;
  for (const piece of pieces) {
    let offset = 0;
    while (offset < piece.text.length) {
      while (r < ranges.length && ranges[r][1] <= pos) r++;
      const inside = r < ranges.length && ranges[r][0] <= pos;
      const boundary = r >= ranges.length ? Infinity : inside ? ranges[r][1] : ranges[r][0];
      const take = Math.min(piece.text.length - offset, boundary - pos);
      out.push({ ...piece, text: piece.text.slice(offset, offset + take), hit: (inside && hit(ranges[r], r)) || piece.hit });
      offset += take;
      pos += take;
    }
  }
  return out;
}

function withHits(pieces: Piece[], render: (p: Piece, key: number) => React.ReactNode, isCurrent: (hit: number) => boolean) {
  const out: React.ReactNode[] = [];
  let i = 0;
  while (i < pieces.length) {
    const hit = pieces[i].hit;
    if (!hit) {
      out.push(render(pieces[i], i++));
      continue;
    }
    const group: React.ReactNode[] = [];
    while (i < pieces.length && pieces[i].hit === hit) group.push(render(pieces[i], i++));
    out.push(
      <mark key={`m${i}`} className={isCurrent(hit) ? "hit is-current" : "hit"}>
        {group}
      </mark>,
    );
  }
  return out;
}

const BIDI = /([\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069])/;

function showBidi(text: string): React.ReactNode {
  if (!BIDI.test(text)) return text;
  return text.split(BIDI).map((s, i) =>
    i % 2 ? (
      <span key={i} className="bidi" title={`U+${s.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`}>
        ⇄
      </span>
    ) : (
      s
    ),
  );
}

function renderPiece(p: Piece, key: number) {
  const text = showBidi(p.text);
  if (!p.color && !p.fontStyle) return typeof text === "string" ? text : <span key={key}>{text}</span>;
  const style: React.CSSProperties = { color: p.color || undefined };
  if (p.fontStyle & BOLD) style.fontWeight = 700;
  if (p.fontStyle & ITALIC) {
    style.fontStyle = "italic";
    style.fontWeight = 400;
  }
  return (
    <span key={key} style={style}>
      {text}
    </span>
  );
}

function tokensMatch(tokens: Tok[], text: string) {
  let at = 0;
  for (const [t] of tokens) {
    if (!text.startsWith(t, at)) return false;
    at += t.length;
  }
  return at === text.length;
}
