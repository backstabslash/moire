import type { Tok } from "../highlight/types";
import { codePoint, invisibleName, MARKED } from "../model/invisible";
import { type Swatch, swatches } from "../model/swatch";
import type { Range } from "../model/words";

interface Piece {
  text: string;
  color?: string;
  fontStyle: number;
  hit?: number;
  wbr?: boolean;
  join?: boolean;
  swatch?: string;
  marked?: boolean;
  trailing?: boolean;
}

const ITALIC = 1;
const BOLD = 2;
const NARROWEST_PANE_CHARS = 40;
const BREAK_AFTER = /[,(=/]|(?<!\d)\.(?!\d)/g;
const WORD_JOINER = "\u2060";

function indentOf(text: string): number {
  return text.length - text.trimStart().length;
}

export function withoutJoins(text: string): string {
  return text.replaceAll(WORD_JOINER, "");
}

function splitAtWrapPoints(pieces: Piece[], text: string): Piece[] {
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
  styles?: boolean;
  changed?: boolean;
}

export function Code({ text, tokens, words, mark, hits, current, styles, changed }: CodeProps) {
  if (!text) return "​";
  // Diff lines from CRLF files keep their CR, which the highlighter strips.
  const cr = text.endsWith("\r") ? "\r" : "";
  let pieces: Piece[] = [{ text, fontStyle: 0 }];
  if (tokens && tokensMatch(tokens, text)) pieces = tokens.map(([t, color, fontStyle]) => ({ text: t, color, fontStyle }));
  else if (tokens && cr && tokensMatch(tokens, text.slice(0, -1)))
    pieces = [...tokens.map(([t, color, fontStyle]): Piece => ({ text: t, color, fontStyle })), { text: cr, fontStyle: 0 }];
  if (text.length > NARROWEST_PANE_CHARS) pieces = splitAtWrapPoints(pieces, text);
  pieces = withSwatches(pieces, swatches(text, !!styles));
  if (changed) pieces = withMarks(pieces, text.trimEnd().length);
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

function withMarks(pieces: Piece[], codeEnd: number): Piece[] {
  let pos = 0;
  return pieces.flatMap((piece): Piece[] => {
    const cut = codeEnd - pos;
    pos += piece.text.length;
    if (cut >= piece.text.length) return [{ ...piece, marked: true }];
    if (cut <= 0) return [{ ...piece, marked: true, trailing: true }];
    return [
      { ...piece, marked: true, text: piece.text.slice(0, cut) },
      { ...piece, marked: true, trailing: true, text: piece.text.slice(cut), wbr: false, join: false, swatch: undefined },
    ];
  });
}

function withSwatches(pieces: Piece[], spots: Swatch[]): Piece[] {
  const valid = spots.filter((s) => CSS.supports("color", s.color));
  if (!valid.length) return pieces;
  const out: Piece[] = [];
  let pos = 0;
  let s = 0;
  for (const piece of pieces) {
    let offset = 0;
    while (s < valid.length && valid[s].at < pos + piece.text.length) {
      const cut = valid[s].at - pos;
      if (cut > offset) out.push({ ...piece, text: piece.text.slice(offset, cut) });
      const next = valid[s + 1]?.at ?? Infinity;
      const end = Math.min(piece.text.length, next - pos);
      out.push({ ...piece, text: piece.text.slice(cut, end), swatch: valid[s].color, wbr: cut === 0 && piece.wbr, join: cut === 0 && piece.join });
      offset = end;
      s++;
    }
    if (offset < piece.text.length) out.push({ ...piece, text: piece.text.slice(offset), wbr: offset === 0 && piece.wbr, join: offset === 0 && piece.join });
    pos += piece.text.length;
  }
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
        swatch: first ? piece.swatch : undefined,
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

function showBidi(text: string, marked?: boolean): React.ReactNode {
  if (!BIDI.test(text)) return marked ? showHidden(text) : text;
  return text.split(BIDI).map((s, i) =>
    i % 2 ? (
      <span key={i} className="bidi" data-tip={codePoint(s)}>
        ⇄
      </span>
    ) : marked ? (
      <span key={i}>{showHidden(s)}</span>
    ) : (
      s
    ),
  );
}

// The real character stays in the text and the label is CSS, so copying a line gives back what's in the file.
function showHidden(text: string): React.ReactNode {
  if (!MARKED.test(text)) return text;
  return text.split(MARKED).map((s, i) => {
    if (!(i % 2)) return s;
    if (s === "\t") return <span key={i} className="ws-tab" children={s} />;
    return <span key={i} className="invisible-char" data-name={invisibleName(s)} data-tip={codePoint(s)} children={s} />;
  });
}

function renderPiece(p: Piece, key: number): React.ReactNode {
  if (p.wbr) return [<wbr key={`w${key}`} />, renderPiece({ ...p, wbr: false }, key)];
  if (p.swatch) return [<i key={`s${key}`} className="swatch" style={{ background: p.swatch }} />, renderPiece({ ...p, swatch: undefined }, key)];
  const shown = showBidi(p.text, p.marked);
  const joined = p.join ? (typeof shown === "string" ? WORD_JOINER + shown : [WORD_JOINER, shown]) : shown;
  const text = p.trailing ? <span className="ws-trail">{joined}</span> : joined;
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
