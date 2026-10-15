import type { Tok } from "../highlight/types";
import type { Range } from "../model/words";

interface Piece {
  text: string;
  color?: string;
  fontStyle: number;
  hit?: number;
  wbr?: boolean;
  join?: boolean;
}

const ITALIC = 1;
const BOLD = 2;
// Shorter lines fit even the narrowest pane, so they skip the wrapping hints.
const WRAP_HINT_MIN = 40;
const TAB_WIDTH = 4;
const BREAK_AFTER = /[,(=/]|(?<!\d)\.(?!\d)/g;
// Word joiner: keeps a line's indentation on the same row as its first word.
const JOIN = "\u2060";

function indentOf(text: string): number {
  return text.length - text.trimStart().length;
}

export function hangingIndent(text: string): React.CSSProperties | undefined {
  const indent = indentOf(text);
  if (text.length <= WRAP_HINT_MIN || !indent) return undefined;
  let cols = 0;
  for (const ch of text.slice(0, indent)) cols += ch === "\t" ? TAB_WIDTH : 1;
  return { paddingLeft: `calc(8px + ${cols + 2}ch)`, textIndent: `-${cols + 2}ch`, "--hang": `${cols}ch` } as React.CSSProperties;
}

export function withoutJoins(text: string): string {
  return text.replaceAll(JOIN, "");
}

// Splits pieces where a line may wrap: after punctuation, and where the indentation ends.
function cut(pieces: Piece[], text: string): Piece[] {
  const breaks = new Set<number>();
  for (const m of text.matchAll(BREAK_AFTER)) if (text[m.index + 1] && text[m.index + 1] !== " ") breaks.add(m.index + 1);
  const indent = indentOf(text);
  const join = indent > 0 && indent < text.length ? indent : -1;
  const out: Piece[] = [];
  let pos = 0;
  for (const p of pieces) {
    let from = 0;
    for (let i = 1; i <= p.text.length; i++) {
      if (i < p.text.length && !breaks.has(pos + i) && pos + i !== join) continue;
      const start = pos + from;
      out.push({ ...p, text: p.text.slice(from, i), wbr: breaks.has(start), join: start === join });
      from = i;
    }
    pos += p.text.length;
  }
  return out;
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
  let pieces: Piece[] = tokens && tokensMatch(tokens, text) ? tokens.map(([t, color, fontStyle]) => ({ text: t, color, fontStyle })) : [{ text, fontStyle: 0 }];
  if (text.length > WRAP_HINT_MIN) pieces = cut(pieces, text);
  if (hits?.length) pieces = splitAt(pieces, hits, (_, i) => i + 1);
  const isCurrent = (hit: number) => hits?.[hit - 1]?.[0] === current;
  if (!words?.length) return withHits(pieces, isCurrent);

  const out: React.ReactNode[] = [];
  let run: Piece[] = [];
  let runInside = false;
  let pos = 0;
  let w = 0;
  const flush = () => {
    if (!run.length) return;
    const rendered = withHits(run, isCurrent);
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
      const first = offset === 0;
      out.push({
        ...piece,
        text: piece.text.slice(offset, offset + take),
        hit: (inside && hit(ranges[r], r)) || piece.hit,
        wbr: first && piece.wbr,
        join: first && piece.join,
      });
      offset += take;
      pos += take;
    }
  }
  return out;
}

function withHits(pieces: Piece[], isCurrent: (hit: number) => boolean) {
  const out: React.ReactNode[] = [];
  let i = 0;
  while (i < pieces.length) {
    const hit = pieces[i].hit;
    if (!hit) {
      out.push(renderPiece(pieces[i], i++));
      continue;
    }
    const group: React.ReactNode[] = [];
    while (i < pieces.length && pieces[i].hit === hit) group.push(renderPiece(pieces[i], i++));
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

function renderPiece(p: Piece, key: number): React.ReactNode {
  if (p.wbr) return [<wbr key={`w${key}`} />, renderPiece({ ...p, wbr: false }, key)];
  const text = showBidi(p.join ? JOIN + p.text : p.text);
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
